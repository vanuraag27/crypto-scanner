// cryptoScanner.js
// Webhook-only crypto scanner with baseline, alerts, scheduler, and admin commands.

const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

// Optional project config fallback (if you keep a config.js)
let configFallback = {};
try {
  configFallback = require("./config");
} catch (e) {
  // config.js not required; we will use process.env
}

// logger (expects logger.js to exist). If missing, fallback to console.
let logger = console;
try {
  logger = require("./logger");
} catch (e) {
  logger = {
    log: console.log,
  };
}

// Helper log wrapper (consistent format)
function log(msg) {
  logger.log ? logger.log(msg) : console.log(msg);
}

// --- Read config (env preferred, fall back to config.js) ---
const TOKEN = process.env.TELEGRAM_TOKEN || configFallback.TELEGRAM_TOKEN || configFallback.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || configFallback.BASE_URL || process.env.RENDER_EXTERNAL_URL;
const ADMIN_ID = (process.env.ADMIN_ID || configFallback.ADMIN_ID || "").toString();
const CHAT_ID = process.env.CHAT_ID || configFallback.CHAT_ID || null;
const CMC_API_KEY = process.env.CMC_API_KEY || configFallback.CMC_API_KEY;
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR ?? configFallback.BASELINE_HOUR ?? "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE ?? configFallback.BASELINE_MINUTE ?? "0", 10);
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL ?? configFallback.REFRESH_INTERVAL ?? "60000", 10);
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT ?? configFallback.ALERT_DROP_PERCENT ?? "-10"); // negative or -10
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT ?? configFallback.FETCH_LIMIT ?? "50", 10);
const USE_TELEGRAM = (process.env.USE_TELEGRAM ?? configFallback.USE_TELEGRAM ?? "true").toString() === "true";
const PORT = parseInt(process.env.PORT ?? configFallback.PORT ?? "10000", 10);

// sanity checks
if (!TOKEN) {
  log("❌ TELEGRAM_TOKEN missing. Set TELEGRAM_TOKEN env var or config.js.");
  process.exit(1);
}
if (!BASE_URL) {
  log("❌ BASE_URL missing. Set BASE_URL env var (e.g. https://your-app.onrender.com).");
  process.exit(1);
}
if (!CMC_API_KEY) {
  log("❌ CMC_API_KEY missing. Set CMC_API_KEY env var (CoinMarketCap PRO API key).");
  process.exit(1);
}

// --- Persistence files ---
const BASELINE_FILE = path.join(__dirname, "baseline.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOGS_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// load baseline
let baseline = { date: null, setAt: null, coins: [] };
try {
  if (fs.existsSync(BASELINE_FILE)) baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
} catch (e) {
  log("⚠️ Failed to read baseline.json, starting fresh.");
}

// load alerts (list of alerted symbols for current baseline)
let alerts = { baselineDate: null, fired: [] };
try {
  if (fs.existsSync(ALERTS_FILE)) alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
} catch (e) {
  log("⚠️ Failed to read alerts.json, starting fresh.");
}

function saveBaseline() {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), "utf8");
}
function saveAlerts() {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), "utf8");
}

// utilities - IST date/time
function nowISTDate() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayISTDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}
function logLine(message) {
  // append to daily log file and print once
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] ${message}`;
  console.log(line);
  const logfile = path.join(LOGS_DIR, `${todayISTDateStr()}.log`);
  try {
    fs.appendFileSync(logfile, line + "\n", "utf8");
  } catch (e) {
    console.log("Failed to write log file:", e.message);
  }
}

// --- HTTP + Bot setup (webhook) ---
const app = express();
app.use(express.json());

const bot = new Telegraf(TOKEN);

// attach webhook callback path
app.use(bot.webhookCallback("/webhook"));

// set webhook (async init)
async function setWebhook() {
  try {
    const webhookUrl = `${BASE_URL.replace(/\/$/, "")}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    logLine(`✅ Webhook set to ${webhookUrl}`);
  } catch (err) {
    logLine("❌ Error setting webhook: " + (err?.response?.description || err.message));
    // do not exit; let the error be visible and try again later manually if needed
  }
}

// --- CoinMarketCap fetcher ---
async function fetchTopCoins(limit = FETCH_LIMIT) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
      timeout: 15000,
    });
    if (res.data && res.data.data) {
      return res.data.data.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        price: c.quote.USD.price,
        change24h: c.quote.USD.percent_change_24h,
      }));
    }
    return [];
  } catch (err) {
    // handle rate limit and other errors gracefully
    logLine("❌ Error fetching coins: " + (err?.response?.data?.status?.error_message || err.message));
    return [];
  }
}

// --- Baseline setter ---
async function setBaseline(manual = false, chatId = null) {
  const today = todayISTDateStr();
  if (!manual && baseline.date === today) {
    logLine("Baseline already set for today, skipping.");
    return false;
  }

  const coins = await fetchTopCoins(FETCH_LIMIT);
  if (!coins.length) {
    logLine("❌ Could not fetch coins to set baseline.");
    return false;
  }

  // pick top 10 by 24h percent change (or top by rank - here we pick by 24h momentum)
  const top10 = coins.slice().sort((a, b) => b.change24h - a.change24h).slice(0, 10);

  baseline = {
    date: today,
    setAt: nowISTDate(),
    coins: top10.map((c) => ({ symbol: c.symbol, name: c.name, price: c.price, change24h: c.change24h })),
  };

  // reset alerts for new baseline
  alerts = { baselineDate: baseline.date, fired: [] };

  saveBaseline();
  saveAlerts();

  const header = manual ? "✅ Manual baseline set — " : "📌 Baseline set — ";
  const msgLines = [
    `${header}${baseline.setAt}`,
    `Monitoring top 10 (baseline day: ${baseline.date}):`,
    ...baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change24h.toFixed(2)}%)`),
  ];
  const msg = msgLines.join("\n");

  logLine(`${manual ? "Manual" : "Auto"} baseline set: ${baseline.date}`);

  if (USE_TELEGRAM) {
    const target = chatId || CHAT_ID || alerts.savedChat || null;
    if (target) {
      try {
        await bot.telegram.sendMessage(target, msg);
        logLine("📩 Baseline message sent to chat.");
      } catch (e) {
        logLine("❌ Failed to send baseline message: " + (e?.response?.description || e.message));
      }
    } else {
      logLine("⚠️ No chat configured to send baseline message.");
    }
  }

  return true;
}

// --- Alerts check (runs frequently) ---
async function checkAlerts() {
  if (!baseline || !baseline.date || !baseline.coins || !baseline.coins.length) return;
  const today = todayISTDateStr();
  if (baseline.date !== today) return; // only check against today's baseline

  const liveCoins = await fetchTopCoins(FETCH_LIMIT);
  if (!liveCoins.length) return;

  for (const b of baseline.coins) {
    // find live price for the symbol
    const live = liveCoins.find((c) => c.symbol === b.symbol);
    if (!live) continue;

    const dropPercent = ((live.price - b.price) / b.price) * 100; // negative if dropped
    if (dropPercent <= ALERT_DROP_PERCENT && !alerts.fired.includes(b.symbol)) {
      // fire alert and persist
      alerts.fired.push(b.symbol);
      saveAlerts();

      const now = nowISTDate();
      const alertMsg = [
        `🚨 ALERT: ${b.symbol} dropped ${dropPercent.toFixed(2)}%`,
        `Baseline: $${b.price.toFixed(4)}`,
        `Now: $${live.price.toFixed(4)}`,
        `Time (IST): ${now}`,
      ].join("\n");

      logLine(`🚨 Alert fired for ${b.symbol}: ${dropPercent.toFixed(2)}%`);

      if (USE_TELEGRAM) {
        const target = CHAT_ID || alerts.savedChat || null;
        if (target) {
          try {
            await bot.telegram.sendMessage(target, alertMsg);
          } catch (e) {
            logLine("❌ Failed to send alert message: " + (e?.response?.description || e.message));
          }
        } else {
          logLine("⚠️ No chat configured to send alert.");
        }
      }
    }
  }
}

// --- Daily summary (10:00 PM IST) ---
async function sendDailySummary() {
  if (!baseline || !baseline.coins || !baseline.coins.length) return;
  const liveCoins = await fetchTopCoins(FETCH_LIMIT);
  if (!liveCoins.length) return;

  const lines = [`📊 Daily Summary (${nowISTDate()})`, `Baseline set at: ${baseline.setAt}`, "Ranked (best → worst):"];
  const perf = baseline.coins.map((b) => {
    const live = liveCoins.find((c) => c.symbol === b.symbol);
    if (!live) return { symbol: b.symbol, change: 0, from: b.price, to: b.price };
    const change = ((live.price - b.price) / b.price) * 100;
    return { symbol: b.symbol, change, from: b.price, to: live.price };
  });
  perf.sort((a, b) => b.change - a.change);
  perf.forEach((p, i) => {
    const flag = p.change <= -5 ? "🔴" : p.change >= 1 ? "🟢" : "";
    lines.push(`${i + 1}. ${p.symbol} -> ${p.change.toFixed(2)}% ${flag} (from $${p.from.toFixed(4)} → $${p.to.toFixed(4)})`);
  });
  const msg = lines.join("\n");
  logLine("📊 Daily summary producing.");
  if (USE_TELEGRAM) {
    const target = CHAT_ID || alerts.savedChat || null;
    if (target) {
      try {
        await bot.telegram.sendMessage(target, msg);
        logLine("📩 Daily summary sent.");
      } catch (e) {
        logLine("❌ Failed to send daily summary: " + (e?.response?.description || e.message));
      }
    } else {
      logLine("⚠️ No chat configured to send daily summary.");
    }
  }
}

// --- Telegram bot commands ---
bot.start(async (ctx) => {
  // store chat for push messages
  alerts.savedChat = ctx.chat.id;
  saveAlerts();
  const msg = [
    "👋 Welcome! You will receive crypto scanner updates here.",
    "",
    "Commands:",
    "/status - scanner & baseline status",
    "/top10 - show today's baseline (set at baseline time)",
    "/profit - ranked % profit since baseline (best→worst)",
    "/alerts - list today's alerts",
    "/setbaseline - admin only (force baseline now)",
    "/clearhistory - admin only (reset alerts for baseline day)",
    "/logs - admin only (last 30 log lines)"
  ].join("\n");
  try {
    await ctx.reply(msg);
    logLine(`Saved chatId from /start: ${ctx.chat.id}`);
  } catch (e) {
    logLine("❌ Failed to reply to /start: " + e.message);
  }
});

bot.command("status", async (ctx) => {
  const reply = baseline.date
    ? `✅ Scanner running.\nBaseline day: ${baseline.date} (set at ${baseline.setAt})\nActive alerts today: ${alerts.fired.length}`
    : "⚠️ Baseline not set yet. Baseline is set automatically at scheduled time or by admin /setbaseline.";
  await ctx.reply(reply);
});

bot.command("top10", async (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  const lines = [`📊 Baseline Top 10 (day: ${baseline.date}, set at ${baseline.setAt}):`];
  baseline.coins.forEach((c, i) => lines.push(`${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change24h.toFixed(2)}%)`));
  await ctx.reply(lines.join("\n"));
});

bot.command("profit", async (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  const live = await fetchTopCoins(FETCH_LIMIT);
  const perf = baseline.coins.map((b) => {
    const L = live.find((c) => c.symbol === b.symbol);
    const now = L ? L.price : b.price;
    const change = ((now - b.price) / b.price) * 100;
    return { symbol: b.symbol, change, from: b.price, to: now };
  }).sort((a, b) => b.change - a.change);
  const lines = [`📈 Profit since baseline (${baseline.date}):`];
  perf.forEach((p, i) => lines.push(`${i + 1}. ${p.symbol} → ${p.change.toFixed(2)}% (from $${p.from.toFixed(4)} → $${p.to.toFixed(4)})`));
  await ctx.reply(lines.join("\n"));
});

bot.command("alerts", async (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  const text = alerts.fired.length ? `🔔 Alerts for ${baseline.date}: ${alerts.fired.join(", ")}` : `🔔 Alerts for ${baseline.date}: None`;
  await ctx.reply(text);
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Not authorized.");
  const ok = await setBaseline(true, ctx.chat.id);
  if (ok) return ctx.reply(`✅ Manual baseline set — ${nowISTDate()}`);
  return ctx.reply("⚠️ Failed to set baseline (check logs).");
});

bot.command("clearhistory", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Not authorized.");
  alerts = { baselineDate: baseline.date, fired: [] };
  saveAlerts();
  await ctx.reply("🧹 Alerts cleared for today.");
  logLine("🧹 Alerts cleared by admin.");
});

bot.command("logs", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Not authorized.");
  const logFile = path.join(LOGS_DIR, `${todayISTDateStr()}.log`);
  if (!fs.existsSync(logFile)) return ctx.reply("⚠️ No logs found for today.");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  const last = lines.slice(-30).join("\n");
  // use MarkdownV2-safe message (escape backticks)
  await ctx.replyWithMarkdownV2("📜 *Last 30 log entries:*\n```\n" + last.replace(/`/g, "'") + "\n```");
});

// --- Scheduler setup ---
// 1) schedule daily baseline at BASELINE_HOUR:BASELINE_MINUTE (IST)
const rule = new schedule.RecurrenceRule();
rule.tz = "Asia/Kolkata";
rule.hour = BASELINE_HOUR;
rule.minute = BASELINE_MINUTE;
schedule.scheduleJob(rule, async () => {
  logLine(`⏰ Cron: running baseline job at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST`);
  await setBaseline(false);
});

// 2) schedule daily summary at 22:00 IST
const summaryRule = new schedule.RecurrenceRule();
summaryRule.tz = "Asia/Kolkata";
summaryRule.hour = 22;
summaryRule.minute = 0;
schedule.scheduleJob(summaryRule, async () => {
  logLine("⏰ Cron: sending daily summary at 22:00 IST");
  await sendDailySummary();
});

// 3) monitoring loop for alerts (runs at REFRESH_INTERVAL)
setInterval(() => {
  checkAlerts().catch((e) => logLine("❌ checkAlerts error: " + e.message));
}, Math.max(10000, REFRESH_INTERVAL)); // minimum 10s to avoid insane loops

// --- Start server and set webhook ---
(async () => {
  try {
    await setWebhook();
  } catch (e) {
    logLine("❌ setWebhook error: " + e.message);
  }

  app.get("/", (req, res) => res.send("Crypto scanner bot (webhook) is running"));

  app.listen(PORT, () => {
    logLine(`🌍 Server listening on port ${PORT}`);
    logLine(`Configuration: BASELINE ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | REFRESH_INTERVAL ${REFRESH_INTERVAL}ms | ALERT_DROP_PERCENT ${ALERT_DROP_PERCENT}%`);
    if (!baseline.date) {
      logLine(`⚠️ No baseline set yet. Will auto-create at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin can run /setbaseline.`);
    } else {
      logLine(`Loaded baseline for ${baseline.date}, set at ${baseline.setAt}`);
    }
  });
})();
