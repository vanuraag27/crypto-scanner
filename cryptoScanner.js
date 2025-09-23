/**
 * cryptoScanner.js
 * Telegram Crypto Scanner Bot with Baseline + Alerts + Predictions
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const schedule = require("node-schedule");

// ========================= CONFIG =========================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = process.env.BASE_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000", 10);
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0", 10);
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50", 10);
const CMC_API_KEY = process.env.CMC_API_KEY;

if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN is missing. Please set it in environment variables.");
  process.exit(1);
}

// ========================= FILE PATHS =========================
const DATA_FILE = path.join(__dirname, "data.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOG_DIR = path.join(__dirname, "logs");

// ========================= HELPERS =========================
function logFileName() {
  const d = new Date();
  return path.join(LOG_DIR, `${d.toISOString().split("T")[0]}.log`);
}

function log(msg) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
  const line = `[${new Date().toLocaleString()}] ${msg}\n`;
  fs.appendFileSync(logFileName(), line);
  console.log(line.trim());
}

function loadJSON(file, def) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file));
    }
  } catch (e) {
    log(`⚠️ Error reading ${file}: ${e.message}`);
  }
  return def;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`⚠️ Error writing ${file}: ${e.message}`);
  }
}

// ========================= STATE =========================
let baseline = loadJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
let alerts = loadJSON(ALERTS_FILE, []);

// ========================= TELEGRAM BOT =========================
const bot = new Telegraf(TELEGRAM_TOKEN);

// Commands
bot.start((ctx) => {
  const msg =
    "👋 Welcome! You will receive crypto scanner updates here.\n\n" +
    "📌 Commands:\n" +
    "/start - register this chat\n" +
    "/help - show this message\n" +
    "/status - scanner & baseline status\n" +
    "/top10 - show today's baseline\n" +
    "/profit - ranked % profit since baseline\n" +
    "/alerts - list current alerts\n" +
    "/setbaseline - admin only (force baseline)\n" +
    "/clearhistory - admin only (clear alerts)\n" +
    "/logs - view today’s log\n" +
    "/predict10 - predict top 10 coins (24h gain ≥20%, volume ≥$50M, market cap ≥$500M)";
  ctx.reply(msg);
});

bot.command("help", (ctx) => ctx.reply("Use /start to see available commands."));
bot.command("status", (ctx) => {
  ctx.reply(
    `✅ Scanner running.\nBaseline day: ${baseline.date || "N/A"}\nCoins tracked: ${
      baseline.coins.length
    }\nActive alerts: ${alerts.length}`
  );
});

bot.command("top10", (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ No baseline set yet.");
  let msg = `📊 Baseline Top 10 (day: ${baseline.date}, set at ${baseline.setAt})\n`;
  baseline.coins.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} — $${c.price} (24h: ${c.percent_change_24h.toFixed(2)}%)\n`;
  });
  ctx.reply(msg);
});

bot.command("profit", (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ No baseline set yet.");
  let msg = `📈 Profit since baseline (${baseline.date})\n`;
  baseline.coins
    .map((coin) => {
      const latest = coin.latest || coin.price;
      const profit = ((latest - coin.price) / coin.price) * 100;
      return { symbol: coin.symbol, profit, from: coin.price, to: latest };
    })
    .sort((a, b) => b.profit - a.profit)
    .forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} → ${c.profit.toFixed(2)}% (from $${c.from} to $${c.to})\n`;
    });
  ctx.reply(msg);
});

bot.command("alerts", (ctx) => {
  if (alerts.length === 0) return ctx.reply("🔔 No alerts triggered yet.");
  let msg = "🔔 Alerts:\n";
  alerts.forEach((a) => {
    msg += `${a.symbol} dropped ${a.drop.toFixed(2)}% since baseline.\n`;
  });
  ctx.reply(msg);
});

bot.command("setbaseline", async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("❌ Admin only.");
  await setBaseline();
  ctx.reply("✅ Manual baseline set.");
});

bot.command("clearhistory", (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("❌ Admin only.");
  alerts = [];
  saveJSON(ALERTS_FILE, alerts);
  ctx.reply("🧹 Alerts cleared.");
});

bot.command("logs", (ctx) => {
  const file = logFileName();
  if (!fs.existsSync(file)) return ctx.reply("⚠️ No logs for today.");
  const lines = fs.readFileSync(file, "utf8").split("\n").slice(-20).join("\n");
  ctx.reply("📜 Last 20 log entries:\n" + lines);
});

// NEW PREDICTION COMMAND
bot.command("predict10", async (ctx) => {
  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=200&convert=USD`;
    const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } });
    let coins = res.data.data;

    coins = coins.filter(
      (c) =>
        c.quote.USD.percent_change_24h >= 20 &&
        c.quote.USD.volume_24h >= 50000000 &&
        c.quote.USD.market_cap >= 500000000
    );

    coins = coins
      .sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h)
      .slice(0, 10);

    if (coins.length === 0) return ctx.reply("⚠️ No coins match prediction filters today.");

    let msg = "🤖 Predicted Top 10 Gainers (next 24h)\n";
    coins.forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} — $${c.quote.USD.price.toFixed(4)} (24h: ${c.quote.USD.percent_change_24h.toFixed(
        2
      )}%, Vol: $${(c.quote.USD.volume_24h / 1e6).toFixed(1)}M, MC: $${(
        c.quote.USD.market_cap / 1e9
      ).toFixed(1)}B)\n`;
    });
    ctx.reply(msg);
  } catch (e) {
    log("❌ Error in /predict10: " + e.message);
    ctx.reply("⚠️ Failed to fetch predictions.");
  }
});

// ========================= CORE FUNCTIONS =========================
async function fetchCoins() {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${FETCH_LIMIT}&convert=USD`;
  const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } });
  return res.data.data.map((c) => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    percent_change_24h: c.quote.USD.percent_change_24h,
  }));
}

async function setBaseline() {
  const coins = await fetchCoins();
  baseline = {
    date: new Date().toISOString().split("T")[0],
    setAt: new Date().toLocaleString(),
    coins: coins.slice(0, 10),
  };
  saveJSON(DATA_FILE, baseline);
  log("✅ Baseline set.");
}

async function refreshAlerts() {
  if (!baseline.date) return;
  const coins = await fetchCoins();
  baseline.coins.forEach((b) => {
    const live = coins.find((c) => c.symbol === b.symbol);
    if (live) {
      b.latest = live.price;
      const drop = ((live.price - b.price) / b.price) * 100;
      if (drop <= ALERT_DROP_PERCENT && !alerts.find((a) => a.symbol === b.symbol)) {
        alerts.push({ symbol: b.symbol, drop });
        saveJSON(ALERTS_FILE, alerts);
        log(`🚨 Alert: ${b.symbol} dropped ${drop.toFixed(2)}%`);
      }
    }
  });
  saveJSON(DATA_FILE, baseline);
}

// ========================= SCHEDULERS =========================
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, setBaseline);
setInterval(refreshAlerts, REFRESH_INTERVAL);

// ========================= SERVER + WEBHOOK =========================
const app = express();
app.use(express.json());
app.use(bot.webhookCallback("/webhook"));

bot.telegram
  .setWebhook(`${BASE_URL}/webhook`)
  .then(() => log(`✅ Webhook set to ${BASE_URL}/webhook`))
  .catch((e) => log("❌ Webhook error: " + e.message));

app.listen(10000, () => {
  log(`🌍 Server listening on port 10000`);
  log(`Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`);
  if (!baseline.date) log("⚠️ Official baseline not set for today. Will auto-set at configured time.");
});