// cryptoScanner.js
// Webhook-only crypto scanner with official/manual baseline, alerts, daily summary, file storage.

const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const moment = require("moment-timezone");
const logger = require("./logger");

// --------- Read configuration from environment (preferred) ----------
const env = process.env;
const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
const BASE_URL = env.BASE_URL; // e.g. https://your-app.onrender.com
const ADMIN_ID = (env.ADMIN_ID || "").toString();
const CHAT_ID = env.CHAT_ID || null; // optional; chat will be saved when /start used
const CMC_API_KEY = env.CMC_API_KEY;
const BASELINE_HOUR = parseInt(env.BASELINE_HOUR ?? "6", 10);
const BASELINE_MINUTE = parseInt(env.BASELINE_MINUTE ?? "0", 10);
const REFRESH_INTERVAL = Math.max(10000, parseInt(env.REFRESH_INTERVAL ?? "600000", 10)); // min 10s
const ALERT_DROP_PERCENT = parseFloat(env.ALERT_DROP_PERCENT ?? "-10"); // negative -> drop threshold
const FETCH_LIMIT = parseInt(env.FETCH_LIMIT ?? "50", 10);
const PORT = parseInt(env.PORT ?? "10000", 10);

// sanity checks
if (!TELEGRAM_TOKEN) {
  logger.write("❌ TELEGRAM_TOKEN not set. Set TELEGRAM_TOKEN in environment and redeploy.");
  process.exit(1);
}
if (!BASE_URL) {
  logger.write("❌ BASE_URL not set. Set BASE_URL env (e.g. https://your-app.onrender.com).");
  process.exit(1);
}
if (!CMC_API_KEY) {
  logger.write("❌ CMC_API_KEY not set (CoinMarketCap PRO key).");
  process.exit(1);
}

// ---------- persistence files ----------
const BASELINE_PATH = path.join(__dirname, "baseline.json");
const ALERTS_PATH = path.join(__dirname, "alerts.json"); // optional separate (we keep alerts in baseline file too)
const persistenceDefault = {
  official: { date: null, setAt: null, coins: [] },
  manual: { date: null, setAt: null, coins: [] },
  alerts: { baselineDate: null, fired: [], savedChat: null }
};

let persistence = persistenceDefault;
try {
  if (fs.existsSync(BASELINE_PATH)) {
    const txt = fs.readFileSync(BASELINE_PATH, "utf8");
    persistence = JSON.parse(txt);
  } else {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(persistenceDefault, null, 2));
  }
} catch (e) {
  logger.write("⚠️ Failed to load baseline.json, using defaults. " + e.message);
  persistence = JSON.parse(JSON.stringify(persistenceDefault));
}

function savePersistence() {
  try {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(persistence, null, 2), "utf8");
  } catch (e) {
    logger.write("❌ Failed to save baseline.json: " + e.message);
  }
}

// utility (IST)
function nowIST() {
  return moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
}
function todayIST() {
  return moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
}

// ------- Telegram setup (webhook-only) -------
const app = express();
app.use(express.json());

const bot = new Telegraf(TELEGRAM_TOKEN);
app.use(bot.webhookCallback("/webhook"));

// set webhook, awaited in async init
async function configureWebhook() {
  const webhookUrl = `${BASE_URL.replace(/\/$/, "")}/webhook`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    logger.write(`✅ Webhook set to ${webhookUrl}`);
  } catch (err) {
    logger.write("❌ Error setting webhook: " + (err?.response?.description || err.message));
    throw err;
  }
}

// ---------- CoinMarketCap fetch ----------
async function fetchTopCoins(limit = FETCH_LIMIT) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
      timeout: 15000
    });
    if (!res.data || !res.data.data) return [];
    return res.data.data.map((c) => ({
      symbol: c.symbol,
      name: c.name,
      price: c.quote.USD.price,
      change24h: c.quote.USD.percent_change_24h
    }));
  } catch (err) {
    const msg = err?.response?.data?.status?.error_message || err.message;
    logger.write("❌ Error fetching coins: " + msg);
    return [];
  }
}

// ---------- Baseline logic ----------
// Official baseline: auto-set at configured time and saved in persistence.official
// Manual baseline: set via /manualbaseline and saved in persistence.manual (does not overwrite official)

async function setOfficialBaseline(manualCallerChat = null) {
  const coins = await fetchTopCoins(FETCH_LIMIT);
  if (!coins.length) {
    logger.write("⚠️ setOfficialBaseline: fetch returned no coins.");
    return false;
  }
  const top10 = coins.slice().sort((a, b) => b.change24h - a.change24h).slice(0, 10);
  persistence.official = {
    date: todayIST(),
    setAt: nowIST(),
    coins: top10.map(c => ({ symbol: c.symbol, name: c.name, price: c.price, change24h: c.change24h }))
  };
  // reset alerts for the new official baseline
  persistence.alerts = { baselineDate: persistence.official.date, fired: [], savedChat: persistence.alerts.savedChat || null };
  savePersistence();

  const header = manualCallerChat ? "✅ Manual-triggered official baseline set" : "📌 Official baseline set";
  const msg = [
    `${header} — ${persistence.official.setAt}`,
    `Baseline day: ${persistence.official.date}`,
    `Monitoring top 10:`,
    ...persistence.official.coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change24h.toFixed(2)}%)`)
  ].join("\n");

  // send to saved chat or configured CHAT_ID
  const target = (persistence.alerts.savedChat || CHAT_ID);
  if (target) {
    try {
      await bot.telegram.sendMessage(target, msg);
      logger.write("📩 Baseline message sent to chat " + target);
    } catch (e) {
      logger.write("❌ Failed to send baseline message: " + (e?.response?.description || e.message));
    }
  } else {
    logger.write("⚠️ No chat configured to receive baseline message.");
  }

  return true;
}

async function setManualBaseline(ctx = null) {
  const coins = await fetchTopCoins(FETCH_LIMIT);
  if (!coins.length) {
    if (ctx) ctx.reply("⚠️ Could not fetch market data to set manual baseline.");
    logger.write("⚠️ setManualBaseline: fetch returned no coins.");
    return false;
  }
  const top10 = coins.slice().sort((a, b) => b.change24h - a.change24h).slice(0, 10);
  persistence.manual = {
    date: todayIST(),
    setAt: nowIST(),
    coins: top10.map(c => ({ symbol: c.symbol, name: c.name, price: c.price, change24h: c.change24h }))
  };
  savePersistence();
  if (ctx) ctx.reply("✅ Manual baseline set (stored in manual baseline). Use /manualtop10 to view it.");
  logger.write("✅ Manual baseline set by admin.");
  return true;
}

// ---------- Alerts checking ----------
async function checkAlerts() {
  if (!persistence.official || !persistence.official.coins || !persistence.official.coins.length) return;
  if (persistence.official.date !== todayIST()) {
    // if official baseline isn't today's, do not check (we only check for today's baseline)
    return;
  }
  const live = await fetchTopCoins(FETCH_LIMIT);
  if (!live.length) return;
  for (const b of persistence.official.coins) {
    const nowCoin = live.find(c => c.symbol === b.symbol);
    if (!nowCoin) continue;
    const drop = ((nowCoin.price - b.price) / b.price) * 100; // negative if dropped
    if (drop <= ALERT_DROP_PERCENT && !persistence.alerts.fired.includes(b.symbol)) {
      // new alert
      persistence.alerts.fired.push(b.symbol);
      savePersistence();
      const alertMsg = [
        `🚨 ALERT: ${b.symbol} dropped ${drop.toFixed(2)}% since baseline`,
        `Baseline: $${b.price.toFixed(4)}`,
        `Now: $${nowCoin.price.toFixed(4)}`,
        `Time (IST): ${nowIST()}`
      ].join("\n");
      const target = persistence.alerts.savedChat || CHAT_ID;
      if (target) {
        try {
          await bot.telegram.sendMessage(target, alertMsg);
          logger.write(`🚨 Alert sent for ${b.symbol}: ${drop.toFixed(2)}%`);
        } catch (e) {
          logger.write("❌ Failed to send alert: " + (e?.response?.description || e.message));
        }
      } else {
        logger.write("⚠️ Alert not sent (no chat configured).");
      }
    }
  }
}

// ---------- Daily summary at 22:00 IST ----------
async function sendDailySummary() {
  if (!persistence.official || !persistence.official.coins || !persistence.official.coins.length) {
    logger.write("ℹ️ sendDailySummary skipped - no official baseline today.");
    return;
  }
  const live = await fetchTopCoins(FETCH_LIMIT);
  if (!live.length) {
    logger.write("ℹ️ sendDailySummary skipped - couldn't fetch live prices.");
    return;
  }

  const perf = persistence.official.coins.map(b => {
    const L = live.find(c => c.symbol === b.symbol);
    if (!L) return { symbol: b.symbol, change: 0, from: b.price, to: b.price };
    const change = ((L.price - b.price) / b.price) * 100;
    return { symbol: b.symbol, change, from: b.price, to: L.price };
  }).sort((a, b) => b.change - a.change);

  const header = [
    `📊 Daily Summary (${todayIST()} - IST)`,
    `Official baseline set at: ${persistence.official.setAt}`,
    ""
  ];
  const lines = perf.map((p, i) => {
    const flag = p.change <= -5 ? "🔴" : (p.change >= 1 ? "🟢" : "");
    return `${i + 1}. ${p.symbol} → ${p.change.toFixed(2)}% ${flag} (from $${p.from.toFixed(4)} → $${p.to.toFixed(4)})`;
  });

  const alertsText = persistence.alerts.fired.length ? persistence.alerts.fired.join(", ") : "None";
  const msg = header.concat([
    "Ranked (best → worst):",
    ...lines,
    "",
    `🔔 Alerts fired today: ${alertsText}`
  ]).join("\n");

  const target = persistence.alerts.savedChat || CHAT_ID;
  if (target) {
    try {
      await bot.telegram.sendMessage(target, msg);
      logger.write("📩 Daily summary sent.");
    } catch (e) {
      logger.write("❌ Failed to send daily summary: " + (e?.response?.description || e.message));
    }
  } else {
    logger.write("⚠️ Daily summary not sent (no chat configured).");
  }
}

// ---------- formatting helpers ----------
function formatBaselineList(baselineObj) {
  if (!baselineObj || !baselineObj.coins || !baselineObj.coins.length) return "⚠️ Baseline not set.";
  return baselineObj.coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change24h.toFixed(2)}%)`).join("\n");
}

async function computeProfitSinceOfficial() {
  if (!persistence.official || !persistence.official.coins || !persistence.official.coins.length) return [];
  const live = await fetchTopCoins(FETCH_LIMIT);
  const result = persistence.official.coins.map(b => {
    const L = live.find(c => c.symbol === b.symbol);
    const nowPrice = L ? L.price : b.price;
    const change = ((nowPrice - b.price) / b.price) * 100;
    return { symbol: b.symbol, from: b.price, to: nowPrice, change };
  });
  result.sort((a, b) => b.change - a.change);
  return result;
}

// ---------- Bot commands ----------
bot.start(async (ctx) => {
  // save chat for outgoing messages
  persistence.alerts.savedChat = ctx.chat.id;
  savePersistence();
  const msg = [
    "👋 Welcome — Crypto Scanner",
    "",
    "Available commands:",
    "/status - scanner & baseline status",
    "/top10 - show official 6 AM baseline (today)",
    "/profit - ranked % profit since official 6 AM baseline",
    "/alerts - list alerts fired today",
    "",
    "Admin-only:",
    "/manualbaseline - set a manual test baseline now",
    "/manualtop10 - show manual baseline list",
    "/clearhistory - clear today's alerts",
    "/logs - admin only, last 30 log lines"
  ].join("\n");
  try {
    await ctx.reply(msg);
    logger.write(`Saved chatId from /start: ${ctx.chat.id}`);
  } catch (e) {
    logger.write("❌ Failed to reply to /start: " + e.message);
  }
});

bot.command("help", (ctx) => {
  ctx.reply("Use /start to register & see commands.");
});

bot.command("status", (ctx) => {
  const official = persistence.official.date ? `${persistence.official.date} at ${persistence.official.setAt}` : "Not set";
  const manual = persistence.manual.date ? `${persistence.manual.date} at ${persistence.manual.setAt}` : "Not set";
  const alertsCount = persistence.alerts.fired.length;
  ctx.reply(`✅ Scanner running\nOfficial baseline: ${official}\nManual baseline: ${manual}\nAlerts today: ${alertsCount}`);
});

bot.command("top10", (ctx) => {
  const text = formatBaselineList(persistence.official);
  ctx.reply(`📊 Official 6 AM baseline (today):\n${text}`);
});

bot.command("profit", async (ctx) => {
  if (!persistence.official || !persistence.official.coins.length) return ctx.reply("⚠️ Official baseline not set yet.");
  const perf = await computeProfitSinceOfficial();
  if (!perf.length) return ctx.reply("⚠️ Could not compute profit (fetch error).");
  const lines = perf.map((p, i) => `${i + 1}. ${p.symbol} → ${p.change.toFixed(2)}% (from $${p.from.toFixed(4)} → $${p.to.toFixed(4)})`);
  ctx.reply("📈 Profit since official baseline:\n" + lines.join("\n"));
});

bot.command("alerts", (ctx) => {
  if (!persistence.official || !persistence.official.coins.length) return ctx.reply("⚠️ Official baseline not set.");
  const text = persistence.alerts.fired.length ? persistence.alerts.fired.join(", ") : "None";
  ctx.reply(`🔔 Alerts (today): ${text}`);
});

// admin: manual baseline (keeps official intact)
bot.command("manualbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  await setManualBaseline(ctx);
});

// admin: show manual baseline
bot.command("manualtop10", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const text = formatBaselineList(persistence.manual);
  ctx.reply("📊 Manual baseline:\n" + text);
});

// admin: clear today's alerts
bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  persistence.alerts = { baselineDate: persistence.official.date || null, fired: [], savedChat: persistence.alerts.savedChat || null };
  savePersistence();
  ctx.reply("🧹 Today's alerts cleared.");
  logger.write("🧹 Alerts cleared by admin.");
});

// admin: logs (last 30 lines)
bot.command("logs", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const logFile = logger.todayFilePath();
  if (!fs.existsSync(logFile())) {
    return ctx.reply("⚠️ No logs for today.");
  }
  try {
    const lines = fs.readFileSync(logFile(), "utf8").trim().split("\n");
    const last30 = lines.slice(-30).join("\n");
    ctx.replyWithMarkdownV2("📜 *Last 30 log entries:* \n```\n" + last30.replace(/`/g, "'") + "\n```");
  } catch (e) {
    ctx.reply("❌ Could not read log file: " + e.message);
  }
});

// ---------- scheduling ----------
/*
 - official baseline: BASELINE_HOUR:BASELINE_MINUTE (IST)
 - daily summary: 22:00 IST
 - monitoring: REFRESH_INTERVAL
*/
const baselineRule = new schedule.RecurrenceRule();
baselineRule.tz = "Asia/Kolkata";
baselineRule.hour = Number(BASELINE_HOUR);
baselineRule.minute = Number(BASELINE_MINUTE);
schedule.scheduleJob(baselineRule, async () => {
  logger.write(`⏰ Running scheduled official baseline job (${BASELINE_HOUR}:${BASELINE_MINUTE} IST)`);
  try {
    await setOfficialBaseline();
  } catch (e) {
    logger.write("❌ Scheduled baseline job error: " + e.message);
  }
});

const summaryRule = new schedule.RecurrenceRule();
summaryRule.tz = "Asia/Kolkata";
summaryRule.hour = 22;
summaryRule.minute = 0;
schedule.scheduleJob(summaryRule, async () => {
  logger.write("⏰ Running scheduled daily summary (22:00 IST)");
  await sendDailySummary();
});

// monitoring loop (alerts)
setInterval(() => {
  checkAlerts().catch((e) => logger.write("❌ checkAlerts error: " + e.message));
}, REFRESH_INTERVAL);

// ---------- app start and webhook config ----------
(async () => {
  try {
    await configureWebhook();
  } catch (e) {
    logger.write("❌ Fatal: could not set webhook. Exiting.");
    process.exit(1);
  }

  app.get("/", (req, res) => res.send("Crypto Scanner (webhook) is running"));

  app.listen(PORT, () => {
    logger.write(`🌍 Server listening on port ${PORT}`);
    logger.write(`Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`);
    if (!persistence.official.date) {
      logger.write(`⚠️ Official baseline not set for today. Will auto-set at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin can run /manualbaseline.`);
    } else {
      logger.write(`✅ Loaded official baseline for ${persistence.official.date} (set at ${persistence.official.setAt})`);
    }
  });
})();