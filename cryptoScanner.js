import express from "express";
import fs from "fs";
import axios from "axios";
import schedule from "node-schedule";
import { Telegraf } from "telegraf";

// --- Environment ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;

const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

if (!TELEGRAM_TOKEN || !CMC_API_KEY || !BASE_URL) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

// --- File paths ---
const DATA_FILE = "./data.json";
const ALERTS_FILE = "./alerts.json";
const LOG_DIR = "./logs";

// --- Persistence ---
let persist = {
  baseline: { date: null, setAt: null, coins: [] },
  alertsBaseline: null,
  savedChat: null,
  autoProfitEnabled: false
};
if (fs.existsSync(DATA_FILE)) {
  persist = JSON.parse(fs.readFileSync(DATA_FILE));
}
function persistData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(persist, null, 2));
}

// Alerts
let alerts = { alerts: [] };
if (fs.existsSync(ALERTS_FILE)) {
  alerts = JSON.parse(fs.readFileSync(ALERTS_FILE));
}
function saveAlerts() {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

// --- Logging ---
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}\n`;
  console.log(line.trim());
  const file = `${LOG_DIR}/log-${new Date().toISOString().split("T")[0]}.txt`;
  fs.appendFileSync(file, line);
}
// Rotate logs (7 days)
schedule.scheduleJob("0 0 * * *", () => {
  const files = fs.readdirSync(LOG_DIR);
  const cutoff = Date.now() - 7 * 86400000;
  for (const f of files) {
    const path = `${LOG_DIR}/${f}`;
    if (fs.statSync(path).mtimeMs < cutoff) fs.unlinkSync(path);
  }
});

// --- Telegram Bot ---
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);
app.listen(10000, () => log("🌍 Server listening on port 10000"));

// --- Coin fetch ---
async function fetchCoins() {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${FETCH_LIMIT}&convert=USD`;
  const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } });
  return res.data.data.map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    volume: c.quote.USD.volume_24h,
    marketCap: c.quote.USD.market_cap,
    percentChange24h: c.quote.USD.percent_change_24h
  }));
}

// --- Baseline ---
async function setBaseline(manualDate = null) {
  const coins = await fetchCoins();
  const filtered = coins.filter(c =>
    c.percentChange24h >= 20 && c.volume >= 50_000_000 && c.marketCap >= 500_000_000
  ).slice(0, 10);

  persist.baseline = {
    date: manualDate || new Date().toISOString().split("T")[0],
    setAt: new Date().toISOString(),
    coins: filtered
  };
  persist.alertsBaseline = persist.baseline.date;
  alerts = { alerts: [] };
  persistData();
  saveAlerts();

  return filtered;
}
function formatCoins(list) {
  if (!list.length) return "⚠️ No coins match filters now.";
  return list.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(2)} (24h: ${c.percentChange24h.toFixed(2)}%)`).join("\n");
}

// --- Profit Table ---
async function getProfitTable() {
  if (!persist.baseline || !persist.baseline.coins.length) {
    return "⚠️ Baseline not set.";
  }
  const now = await fetchCoins();
  const profits = persist.baseline.coins.map(base => {
    const cur = now.find(c => c.symbol === base.symbol);
    if (!cur) return null;
    const change = ((cur.price - base.price) / base.price) * 100;
    return { symbol: base.symbol, base: base.price, cur: cur.price, change };
  }).filter(Boolean).sort((a, b) => b.change - a.change);

  return "📈 Profit since baseline (" + persist.baseline.date + ")\n" +
    profits.map((p, i) =>
      `${i + 1}. ${p.symbol} → ${p.change.toFixed(2)}% (from $${p.base.toFixed(2)} to $${p.cur.toFixed(2)})`
    ).join("\n");
}

// --- Auto-profit ---
let autoProfitJob = null;
function startAutoProfit(chatId) {
  if (autoProfitJob) return;
  persist.autoProfitEnabled = true;
  persistData();
  autoProfitJob = schedule.scheduleJob("*/5 * * * *", async () => {
    try {
      const table = await getProfitTable();
      await bot.telegram.sendMessage(chatId, "⏱ Auto-profit update:\n" + table);
    } catch (e) {
      log("❌ Auto-profit failed: " + e.message);
    }
  });
}
function stopAutoProfit() {
  if (autoProfitJob) {
    autoProfitJob.cancel();
    autoProfitJob = null;
  }
  persist.autoProfitEnabled = false;
  persistData();
}
function restoreAutoProfit() {
  if (persist.autoProfitEnabled && persist.savedChat) {
    startAutoProfit(persist.savedChat);
  }
}

// --- Commands ---
bot.start(ctx => {
  persist.savedChat = ctx.chat.id;
  persistData();
  ctx.reply("👋 Welcome! You will receive crypto scanner updates here.\n" +
    "📌 Commands:\n" +
    "/status - scanner & baseline status\n" +
    "/top10 - show baseline coins\n" +
    "/profit - show profit since baseline\n" +
    "/alerts - list alerts\n" +
    "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
    "/clearhistory - admin clear alerts\n" +
    "/autoprofit on|off - toggle auto-profit updates");
});

bot.command("status", ctx => {
  ctx.reply(`📊 Baseline date: [${persist.baseline.date}]\nSet at: ${persist.baseline.setAt}\nCoins tracked: ${persist.baseline.coins.length}`);
});

bot.command("top10", ctx => ctx.reply(formatCoins(persist.baseline.coins)));
bot.command("profit", async ctx => ctx.reply(await getProfitTable()));
bot.command("alerts", ctx => ctx.reply("🔔 Alerts: " + (alerts.alerts.length ? alerts.alerts.join(", ") : "None")));

bot.command("setbaseline", async ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const args = ctx.message.text.split(" ");
  const date = args[1] || null;
  const list = await setBaseline(date);
  ctx.reply(`✅ Baseline set (manual) at ${new Date().toLocaleString()}\nDate: [${persist.baseline.date}]\n${formatCoins(list)}`);
});

bot.command("clearhistory", ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  alerts = { alerts: [] };
  saveAlerts();
  ctx.reply("✅ Alerts history cleared.");
});

bot.command("autoprofit", ctx => {
  const arg = ctx.message.text.split(" ")[1];
  if (arg === "on") {
    startAutoProfit(ctx.chat.id);
    ctx.reply("✅ Auto-profit enabled (every 5 minutes).");
  } else if (arg === "off") {
    stopAutoProfit();
    ctx.reply("❌ Auto-profit disabled.");
  } else {
    ctx.reply("Usage: /autoprofit on|off");
  }
});

// --- Scheduler jobs ---
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  const list = await setBaseline();
  await bot.telegram.sendMessage(CHAT_ID, "✅ Baseline set (auto 6AM IST):\n" + formatCoins(list));
});

schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
  const table = await getProfitTable();
  await bot.telegram.sendMessage(CHAT_ID, "🌙 Daily summary 10PM IST:\n" + table);
});

// --- Restore auto-profit ---
restoreAutoProfit();