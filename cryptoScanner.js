const express = require("express");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const { Telegraf } = require("telegraf");
const axios = require("axios");

// === Environment Variables ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;

const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");

if (!TELEGRAM_TOKEN || !BASE_URL || !CMC_API_KEY) {
  console.error("❌ Missing critical environment variables.");
  process.exit(1);
}

// === File Paths ===
const persistenceFile = path.join(__dirname, "data.json");
const alertsFile = path.join(__dirname, "alerts.json");
const logsDir = path.join(__dirname, "logs");

// Ensure logs dir
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// === Logging helper ===
function log(message) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const logLine = `[${ts}] ${message}\n`;
  console.log(logLine.trim());

  const logFile = path.join(logsDir, `log-${new Date().toISOString().split("T")[0]}.txt`);
  fs.appendFileSync(logFile, logLine);

  // Keep only 7 days of logs
  const files = fs.readdirSync(logsDir).sort();
  if (files.length > 7) {
    fs.unlinkSync(path.join(logsDir, files[0]));
  }
}

// === Persistence Helpers ===
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === Load state ===
let baseline = loadJSON(persistenceFile, { date: null, setAt: null, coins: [] });
let alertsState = loadJSON(alertsFile, { baselineDate: null, alerts: [] });

// === Telegram Bot ===
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

app.listen(10000, () => log("🌍 Server listening on port 10000"));

// === CoinMarketCap API Fetch ===
async function fetchTopCoins() {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit: FETCH_LIMIT, convert: "USD" },
    });
    return res.data.data.map((c) => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      percent_change_24h: c.quote.USD.percent_change_24h,
      volume_24h: c.quote.USD.volume_24h,
      market_cap: c.quote.USD.market_cap,
    }));
  } catch (err) {
    log(`❌ Fetch error: ${err.message}`);
    return [];
  }
}

// === Baseline Management ===
async function setBaseline(manual = false) {
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  // Apply filters
  const filtered = coins.filter(
    (c) =>
      c.percent_change_24h >= 20 &&
      c.volume_24h >= 50_000_000 &&
      c.market_cap >= 500_000_000
  );

  const top10 = filtered.slice(0, 10);

  baseline = {
    date: new Date().toISOString().split("T")[0],
    setAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    coins: top10,
  };
  saveJSON(persistenceFile, baseline);

  alertsState = { baselineDate: baseline.date, alerts: [] };
  saveJSON(alertsFile, alertsState);

  const msg = `${manual ? "✅ Manual" : "✅ Auto"} baseline set — ${baseline.setAt}\nMonitoring ${top10.length} coins.`;
  await safeSend(msg);
  log(msg);
}

// === Alerts Check ===
async function checkAlerts() {
  if (!baseline.coins.length) return;
  const coins = await fetchTopCoins();
  for (let b of baseline.coins) {
    const live = coins.find((c) => c.symbol === b.symbol);
    if (!live) continue;

    const change = ((live.price - b.price) / b.price) * 100;
    if (change <= ALERT_DROP_PERCENT) {
      if (!alertsState.alerts.includes(b.symbol)) {
        alertsState.alerts.push(b.symbol);
        saveJSON(alertsFile, alertsState);
        await safeSend(`🚨 ${b.symbol} dropped ${change.toFixed(2)}% since baseline!`);
        log(`ALERT: ${b.symbol} dropped ${change.toFixed(2)}%`);
      }
    }
  }
}

// === Helpers ===
async function safeSend(msg) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, msg);
  } catch (e) {
    log(`❌ Telegram send error: ${e.description || e.message}`);
  }
}

function formatCoins(coins) {
  return coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.percent_change_24h.toFixed(2)}%)`).join("\n");
}

// === Commands ===
bot.start(async (ctx) => {
  saveJSON(persistenceFile, baseline);
  await ctx.reply("👋 Welcome! Commands:\n/start, /help, /status, /top10, /profit, /alerts, /setbaseline (admin), /clearhistory (admin), /logs (admin)");
});

bot.command("help", (ctx) =>
  ctx.reply("📌 Commands:\n/status, /top10, /profit, /alerts, /setbaseline (admin), /clearhistory (admin), /logs (admin)")
);

bot.command("status", (ctx) => {
  ctx.reply(
    `✅ Scanner running.\nBaseline day: ${baseline.date || "N/A"}\nActive alerts: ${alertsState.alerts.length}`
  );
});

bot.command("top10", (ctx) => {
  if (!baseline.coins.length) return ctx.reply("⚠️ No baseline set yet.");
  ctx.reply(`📊 Top 10 (baseline ${baseline.date}, set ${baseline.setAt})\n${formatCoins(baseline.coins)}`);
});

bot.command("profit", async (ctx) => {
  if (!baseline.coins.length) return ctx.reply("⚠️ No baseline set yet.");
  const coins = await fetchTopCoins();
  const msg = baseline.coins
    .map((b, i) => {
      const live = coins.find((c) => c.symbol === b.symbol);
      if (!live) return `${i + 1}. ${b.symbol} → data missing`;
      const change = ((live.price - b.price) / b.price) * 100;
      return `${i + 1}. ${b.symbol} → ${change.toFixed(2)}% (from $${b.price.toFixed(4)} → $${live.price.toFixed(4)})`;
    })
    .join("\n");
  ctx.reply(`📈 Profit since baseline:\n${msg}`);
});

bot.command("alerts", (ctx) => {
  ctx.reply(`🔔 Alerts for baseline ${alertsState.baselineDate || "N/A"}:\n${alertsState.alerts.join(", ") || "None"}`);
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  await setBaseline(true);
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  alertsState = { baselineDate: baseline.date, alerts: [] };
  saveJSON(alertsFile, alertsState);
  ctx.reply("✅ Alerts cleared.");
});

bot.command("logs", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  const files = fs.readdirSync(logsDir).slice(-7);
  ctx.reply(`📜 Logs (last 7 days):\n${files.join("\n")}`);
});

// === Scheduler ===
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, () => {
  setBaseline(false);
});

setInterval(checkAlerts, REFRESH_INTERVAL);

log(`Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`);
log("⚠️ Official baseline not set yet. Will auto-set at baseline time or admin can run /setbaseline.");