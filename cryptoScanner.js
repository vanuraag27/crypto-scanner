// cryptoScanner.js (CommonJS style)

const express = require("express");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const schedule = require("node-schedule");

// === CONFIG FROM ENV ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = process.env.BASE_URL || "http://localhost:10000";
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const CMC_API_KEY = process.env.CMC_API_KEY;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000"); // 10 min
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();

const DATA_FILE = path.join(__dirname, "data.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOG_DIR = path.join(__dirname, "logs");

// Ensure logs folder exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// === Persistence helpers ===
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file));
    }
    return fallback;
  } catch (err) {
    console.error("Error loading", file, err);
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving", file, err);
  }
}

// === State ===
let baseline = loadJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
let alerts = loadJSON(ALERTS_FILE, {});

// === Logging ===
function logLine(msg) {
  const now = new Date();
  const file = path.join(LOG_DIR, `${now.toISOString().split("T")[0]}.log`);
  fs.appendFileSync(file, `[${now.toISOString()}] ${msg}\n`);
}

// === CMC API fetch ===
async function fetchTopCoins(limit = 50) {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${limit}&convert=USD,INR`;
  const res = await axios.get(url, {
    headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
  });
  return res.data.data;
}

// === Baseline ===
async function setBaseline(manualDate = null) {
  const coins = await fetchTopCoins(50);

  // Apply filters
  const filtered = coins.filter((c) => {
    const vol = c.quote.USD.volume_24h || 0;
    const mc = c.quote.USD.market_cap || 0;
    const change = c.quote.USD.percent_change_24h || 0;
    return vol >= 50_000_000 && mc >= 500_000_000 && change >= 20;
  });

  baseline = {
    date: manualDate || new Date().toISOString().split("T")[0],
    setAt: new Date().toISOString(),
    coins: filtered.slice(0, 10).map((c) => ({
      symbol: c.symbol,
      price_usd: c.quote.USD.price,
      price_inr: c.quote.INR.price,
      change: c.quote.USD.percent_change_24h,
    })),
  };

  saveJSON(DATA_FILE, baseline);
  alerts = {};
  saveJSON(ALERTS_FILE, alerts);

  return baseline;
}

// === Profit calculation ===
async function getProfitReport() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) {
    return "⚠️ No baseline set yet.";
  }
  const coins = await fetchTopCoins(50);
  const lines = [];
  baseline.coins.forEach((b) => {
    const live = coins.find((c) => c.symbol === b.symbol);
    if (live) {
      const change =
        ((live.quote.USD.price - b.price_usd) / b.price_usd) * 100;
      lines.push(
        `${b.symbol} → ${change.toFixed(2)}% (from ₹${b.price_inr.toFixed(
          2
        )} to ₹${live.quote.INR.price.toFixed(2)})`
      );
    }
  });
  return "📈 Profit since baseline:\n" + lines.join("\n");
}

// === Telegram Commands ===
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/start - register chat\n" +
      "/help - show commands\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show baseline coins\n" +
      "/profit - show profit since baseline\n" +
      "/alerts - list alerts\n" +
      "/setbaseline [YYYY-MM-DD] - admin only\n" +
      "/clearhistory - admin only\n" +
      "/autoprofit on|off - toggle auto-profit updates"
  );
});

bot.command("help", (ctx) => ctx.reply("Same as /start — shows commands."));

bot.command("status", (ctx) => {
  ctx.reply(
    `📊 Baseline date: ${baseline.date || "N/A"}\nSet at: ${
      baseline.setAt || "N/A"
    }\nCoins tracked: ${baseline.coins.length}`
  );
});

bot.command("top10", (ctx) => {
  if (!baseline || baseline.coins.length === 0) {
    return ctx.reply("⚠️ No baseline set yet.");
  }
  let msg = `📊 Baseline Top 10 (date: ${baseline.date}):\n`;
  baseline.coins.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} — ₹${c.price_inr.toFixed(
      2
    )} (24h: ${c.change.toFixed(2)}%)\n`;
  });
  ctx.reply(msg);
});

bot.command("profit", async (ctx) => {
  const report = await getProfitReport();
  ctx.reply(report);
});

bot.command("alerts", (ctx) => {
  ctx.reply(
    `🔔 Alerts today:\n${
      Object.keys(alerts).length ? Object.keys(alerts).join(", ") : "None"
    }`
  );
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }
  const baselineSet = await setBaseline();
  ctx.reply(
    `✅ Baseline set at ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    })}\nDate: ${baselineSet.date}`
  );
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }
  alerts = {};
  saveJSON(ALERTS_FILE, alerts);
  ctx.reply("🧹 Alerts cleared.");
});

// === Webhook setup ===
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

app.listen(10000, () => {
  console.log("🌍 Server listening on port 10000");
});