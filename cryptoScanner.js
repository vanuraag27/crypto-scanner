/**
 * cryptoScanner.js
 *
 * Webhook-based Telegram crypto scanner.
 *
 * Required environment variables:
 *  - TELEGRAM_TOKEN
 *  - BASE_URL           (eg. https://yourdomain.example)
 *  - ADMIN_ID           (telegram user id string)
 *  - CHAT_ID            (chat id to send scheduled messages)
 *  - CMC_API_KEY
 *  - BASELINE_HOUR      (0-23, IST)
 *  - BASELINE_MINUTE    (0-59, IST)
 *  - REFRESH_INTERVAL   (ms)
 *  - ALERT_DROP_PERCENT (negative number, e.g. -10)
 *  - FETCH_LIMIT        (how many CMC coins to fetch)
 *
 * Files created/used:
 *  - data.json   (baseline snapshot)
 *  - alerts.json (alerts for current baseline day)
 *  - logs/       (daily logs, rotated to keep last 7 days)
 */

const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

// -------------------- ENV / CONFIG --------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = process.env.BASE_URL; // must be HTTPS and reachable by Telegram
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const CHAT_ID = String(process.env.CHAT_ID || "");
const CMC_API_KEY = process.env.CMC_API_KEY;

const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR ?? "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE ?? "0", 10);
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL ?? "60000", 10); // default 60s
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT ?? "-10"); // negative
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT ?? "100", 10);

const PORT = parseInt(process.env.PORT || "10000", 10);

// Basic sanity checks
if (!TELEGRAM_TOKEN || !BASE_URL || !CMC_API_KEY) {
  console.error("Missing required environment variables: TELEGRAM_TOKEN, BASE_URL, or CMC_API_KEY");
  process.exit(1);
}

// -------------------- PATHS --------------------
const DATA_FILE = path.join(__dirname, "data.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOG_DIR = path.join(__dirname, "logs");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// -------------------- LOGGING --------------------
function todayLogFilename() {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
}

function appendLog(line) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const entry = `[${ts}] ${line}`;
  console.log(entry);
  try {
    fs.appendFileSync(todayLogFilename(), entry + "\n", "utf8");
    // rotate: keep only last 7 files
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log")).sort();
    if (files.length > 7) {
      const toDelete = files.slice(0, files.length - 7);
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); appendLog(`Deleted old log ${f}`); } catch {}
      }
    }
  } catch (e) {
    console.error("Failed writing log:", e.message);
  }
}

// -------------------- PERSISTENCE --------------------
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const s = fs.readFileSync(file, "utf8");
    return JSON.parse(s);
  } catch (e) {
    appendLog(`Failed to read ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}
function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    appendLog(`Failed to write ${path.basename(file)}: ${e.message}`);
  }
}

let baseline = readJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
let alertsState = readJSON(ALERTS_FILE, { baselineDate: null, alerted: [] });

// -------------------- TELEGRAM + EXPRESS (WEBHOOK) --------------------
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));

// set webhook on startup (best-effort)
(async function setWebhook() {
  try {
    await bot.telegram.setWebhook(`${BASE_URL}/webhook`);
    appendLog(`✅ Webhook set to ${BASE_URL}/webhook`);
  } catch (e) {
    appendLog(`❌ Error setting webhook: ${e.response?.body || e.message}`);
  }
})();

app.get("/", (req, res) => {
  res.send("Crypto Scanner is running.");
});

app.listen(PORT, () => {
  appendLog(`🌍 Server listening on port ${PORT}`);
  appendLog(`Configuration: baseline ${BASELINE_HOUR}:${String(BASELINE_MINUTE).padStart(2,"0")} IST | refresh ${REFRESH_INTERVAL}ms | alert_drop ${ALERT_DROP_PERCENT}%`);
});

// helper to send (safe)
async function sendToChat(text, parse = false) {
  try {
    const opts = {};
    if (parse) opts.parse_mode = "Markdown";
    await bot.telegram.sendMessage(CHAT_ID, text, opts);
    appendLog(`📩 Sent message to CHAT_ID`);
  } catch (e) {
    appendLog(`❌ Telegram send error: ${e.response?.description || e.message}`);
  }
}

// -------------------- COINFETCH & FILTERS --------------------
async function fetchCMC(limit = FETCH_LIMIT) {
  const url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest";
  try {
    const resp = await axios.get(url, {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
      timeout: 20000
    });
    return resp.data.data || [];
  } catch (e) {
    appendLog(`❌ CMC fetch error: ${e.response?.data?.status || e.message}`);
    return [];
  }
}

function coinToRecord(c) {
  // c is raw coin object from CMC
  return {
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    price: c.quote.USD.price,
    percent_change_24h: c.quote.USD.percent_change_24h || 0,
    volume_24h: c.quote.USD.volume_24h || 0,
    market_cap: c.quote.USD.market_cap || 0
  };
}

function applyFilters(list) {
  // Filters:
  // - 24h gain >= 20%
  // - 24h volume >= $50M
  // - market cap >= $500M
  return list
    .map(coinToRecord)
    .filter(c => c.percent_change_24h >= 20 && c.volume_24h >= 50_000_000 && c.market_cap >= 500_000_000)
    .sort((a, b) => b.percent_change_24h - a.percent_change_24h)
    .slice(0, 10);
}

// -------------------- BASELINE (SET ONLY BY SCHEDULE OR ADMIN) --------------------
async function setBaseline(manual = false) {
  appendLog(`${manual ? "Manual" : "Auto"} baseline requested...`);
  const data = await fetchCMC();
  if (!data.length) {
    appendLog("No coins fetched for baseline.");
    return false;
  }
  const chosen = applyFilters(data);
  baseline = {
    date: new Date().toISOString().split("T")[0], // YYYY-MM-DD
    setAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    coins: chosen.map(c => ({ symbol: c.symbol, price: c.price, change24h: c.percent_change_24h }))
  };
  writeJSON(DATA_FILE, baseline);
  // reset alerts for the new baseline day
  alertsState = { baselineDate: baseline.date, alerted: [] };
  writeJSON(ALERTS_FILE, alertsState);

  // message summary
  let msg = `${manual ? "✅ Manual baseline set" : "✅ Baseline auto-set"} — ${baseline.date} (${baseline.setAt})\n`;
  if (!baseline.coins.length) msg += "⚠️ No coins passed filters today.";
  else {
    msg += "Monitoring top " + baseline.coins.length + " coins:\n";
    baseline.coins.forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} — $${c.price.toFixed(6)} (24h: ${c.change24h.toFixed(2)}%)\n`;
    });
  }
  await sendToChat(msg);
  appendLog("Baseline saved.");
  return true;
}

// -------------------- ALERTS CHECK --------------------
async function checkAlerts() {
  if (!baseline || !baseline.coins || !baseline.coins.length) {
    // nothing to check
    return;
  }
  const data = await fetchCMC();
  if (!data.length) return;
  // convert list for quick lookup
  const liveMap = new Map();
  for (const c of data) liveMap.set(c.symbol, coinToRecord(c));

  for (const b of baseline.coins) {
    const live = liveMap.get(b.symbol);
    if (!live) continue;
    const pct = ((live.price - b.price) / b.price) * 100;
    // only fire if change <= ALERT_DROP_PERCENT and not already alerted this baseline day
    if (pct <= ALERT_DROP_PERCENT && !alertsState.alerted.includes(b.symbol)) {
      // add alert
      alertsState.alerted.push(b.symbol);
      writeJSON(ALERTS_FILE, alertsState);
      const at = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const text = `🔴 ALERT: ${b.symbol} dropped ${pct.toFixed(2)}% since baseline (${baseline.date})\nBaseline: $${b.price}\nNow: $${live.price}\nTime: ${at}\nSuggested: check position / risk management`;
      await sendToChat(text);
      appendLog(`ALERT sent for ${b.symbol} (${pct.toFixed(2)}%)`);
    }
  }
}

// -------------------- DAILY SUMMARY (22:00 IST) --------------------
async function sendDailySummary() {
  if (!baseline || !baseline.coins || !baseline.coins.length) {
    appendLog("Daily summary skipped: no baseline.");
    return;
  }
  const data = await fetchCMC();
  if (!data.length) return;
  const liveMap = new Map();
  for (const c of data) liveMap.set(c.symbol, coinToRecord(c));

  const perf = baseline.coins
    .map(b => {
      const live = liveMap.get(b.symbol);
      if (!live) return null;
      const pct = ((live.price - b.price) / b.price) * 100;
      return { symbol: b.symbol, baseline: b.price, now: live.price, pct };
    })
    .filter(Boolean)
    .sort((a, b) => b.pct - a.pct); // best -> worst

  let msg = `📊 Daily summary (baseline ${baseline.date}) — best → worst\n`;
  perf.forEach((p, i) => {
    msg += `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.baseline.toFixed(6)} → $${p.now.toFixed(6)})\n`;
  });
  await sendToChat(msg);
  appendLog("Daily summary sent.");
}

// -------------------- SCHEDULES --------------------
// Baseline scheduler (runs every day at BASELINE_HOUR:BASELINE_MINUTE IST)
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  appendLog("Scheduled baseline time reached, setting baseline...");
  await setBaseline(false);
});

// Daily summary at 22:00 IST
schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
  appendLog("Scheduled daily summary at 22:00 IST");
  await sendDailySummary();
});

// Monitoring loop — only checks prices and alerts; does NOT modify baseline
setInterval(() => {
  checkAlerts().catch(e => appendLog("checkAlerts error: " + e.message));
}, REFRESH_INTERVAL);

// -------------------- TELEGRAM COMMANDS --------------------
bot.start(async (ctx) => {
  // Save chatId if desired (we have CHAT_ID env already)
  try {
    // welcome + command list
    await ctx.reply(
      "👋 Welcome to Crypto Scanner!\n\n" +
      "Commands:\n" +
      "/help - show this help\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show today's baseline list (requires baseline)\n" +
      "/profit - show profit% vs baseline\n" +
      "/alerts - list active alerts today\n" +
      "/setbaseline - admin only (force baseline now)\n" +
      "/clearhistory - admin only (clear today's alerts)\n" +
      "/logs - admin only (download today's log)\n" +
      "/logfile YYYY-MM-DD - admin only (download specific log)\n"
    );
  } catch (e) {
    appendLog("start command error: " + e.message);
  }
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📌 Commands:\n" +
    "/status\n/top10\n/profit\n/alerts\n/setbaseline (admin)\n/clearhistory (admin)\n/logs (admin)\n/logfile YYYY-MM-DD (admin)"
  );
});

bot.command("status", (ctx) => {
  const msg = baseline && baseline.coins && baseline.coins.length
    ? `✅ Scanner running.\nBaseline: ${baseline.date} (set at ${baseline.setAt})\nMonitoring ${baseline.coins.length} coins.\nActive alerts: ${alertsState.alerted.length}`
    : `⚠️ Scanner running. No official baseline set yet. Baseline will be created at scheduled time or admin can run /setbaseline.`;
  ctx.reply(msg);
});

bot.command("top10", (ctx) => {
  if (!baseline || !baseline.coins || !baseline.coins.length) return ctx.reply("⚠️ Baseline not set yet.");
  let msg = `📊 Baseline Top ${baseline.coins.length} — ${baseline.date} (set ${baseline.setAt})\n`;
  baseline.coins.forEach((c, i) => msg += `${i + 1}. ${c.symbol} — $${c.price.toFixed(6)} (24h: ${c.change24h.toFixed(2)}%)\n`);
  ctx.reply(msg);
});

bot.command("profit", async (ctx) => {
  if (!baseline || !baseline.coins || !baseline.coins.length) return ctx.reply("⚠️ Baseline not set yet.");
  const data = await fetchCMC();
  const liveMap = new Map(data.map(d => [d.symbol, coinToRecord(d)]));
  let out = `📈 Profit since baseline (${baseline.date}) — best → worst\n`;
  const arr = baseline.coins
    .map(b => {
      const live = liveMap.get(b.symbol);
      if (!live) return ({ symbol: b.symbol, pct: null, base: b.price, now: null });
      const pct = ((live.price - b.price) / b.price) * 100;
      return ({ symbol: b.symbol, pct, base: b.price, now: live.price });
    })
    .sort((a, b) => (b.pct ?? -999) - (a.pct ?? -999));
  arr.forEach((r, i) => {
    if (r.pct === null) out += `${i + 1}. ${r.symbol} → data missing\n`;
    else out += `${i + 1}. ${r.symbol} → ${r.pct.toFixed(2)}% (from $${r.base.toFixed(6)} → $${r.now.toFixed(6)})\n`;
  });
  ctx.reply(out);
});

bot.command("alerts", (ctx) => {
  if (!alertsState || !alertsState.alerted || !alertsState.alerted.length) return ctx.reply("🔔 No alerts today.");
  ctx.reply(`🔔 Alerts for baseline ${alertsState.baselineDate}:\n${alertsState.alerted.join(", ")}`);
});

bot.command("setbaseline", async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  await setBaseline(true);
  ctx.reply("✅ Baseline set (manual).");
});

bot.command("clearhistory", (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  alertsState = { baselineDate: baseline.date || null, alerted: [] };
  writeJSON(ALERTS_FILE, alertsState);
  ctx.reply("🗑 Alerts cleared for current baseline.");
  appendLog("Admin cleared alerts.");
});

bot.command("logs", (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  try {
    const lf = todayLogFilename();
    if (!fs.existsSync(lf)) return ctx.reply("⚠️ No log for today.");
    ctx.replyWithDocument({ source: lf });
  } catch (e) {
    appendLog("logs command error: " + e.message);
    ctx.reply("❌ Could not fetch logs.");
  }
});

bot.command("logfile", (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  const parts = ctx.message.text.split(/\s+/);
  const date = parts[1]; // expect YYYY-MM-DD
  if (!date) return ctx.reply("Usage: /logfile YYYY-MM-DD");
  const f = path.join(LOG_DIR, `${date}.log`);
  if (!fs.existsSync(f)) return ctx.reply(`⚠️ Log for ${date} not found. Available: ${fs.readdirSync(LOG_DIR).slice(-7).join(", ")}`);
  ctx.replyWithDocument({ source: f });
});

// default unknown command
bot.on("message", (ctx) => {
  const txt = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : "";
  // ignore messages that match handled commands
  // If it's an unknown command (starts with /), respond with help
  if (txt.startsWith("/")) {
    ctx.reply("Unknown command. Use /help to see available commands.");
  }
});

// -------------------- START LOGIC --------------------
appendLog("🔧 Crypto Scanner started.");

// At startup: don't auto-create baseline unless it's already present in data.json
if (baseline && baseline.date) {
  appendLog(`Loaded baseline for ${baseline.date} (set ${baseline.setAt}).`);
} else {
  appendLog("No official baseline set for today. Will auto-create at scheduled time or admin can run /setbaseline.");
}

// -------------------- export (not used) --------------------
module.exports = {};