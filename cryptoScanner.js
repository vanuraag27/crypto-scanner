// cryptoScanner.js
import express from "express";
import { Telegraf } from "telegraf";
import schedule from "node-schedule";
import axios from "axios";
import fs from "fs";
import path from "path";

// ==========================
// Config
// ==========================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL || "http://localhost:10000";
const CMC_API_KEY = process.env.CMC_API_KEY;
const FETCH_LIMIT = process.env.FETCH_LIMIT || 50;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000"); // 10 min
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || -10);

if (!TELEGRAM_TOKEN || !CMC_API_KEY) {
  console.error("❌ Missing TELEGRAM_TOKEN or CMC_API_KEY in environment.");
  process.exit(1);
}

// ==========================
// Files
// ==========================
const dataFile = path.join(process.cwd(), "data.json");
const alertsFile = path.join(process.cwd(), "alerts.json");
const logsDir = path.join(process.cwd(), "logs");

if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({ date: null, setAt: null, coins: [] }, null, 2));
if (!fs.existsSync(alertsFile)) fs.writeFileSync(alertsFile, JSON.stringify([], null, 2));
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// ==========================
// Helpers
// ==========================
function loadPersistence() {
  return JSON.parse(fs.readFileSync(dataFile));
}
function savePersistence(p) {
  fs.writeFileSync(dataFile, JSON.stringify(p, null, 2));
}

function logFileName() {
  const date = new Date().toISOString().split("T")[0];
  return path.join(logsDir, `${date}.log`);
}
function writeLog(msg) {
  fs.appendFileSync(logFileName(), `[${new Date().toLocaleString()}] ${msg}\n`);
  cleanupOldLogs();
}
function cleanupOldLogs() {
  const files = fs.readdirSync(logsDir).sort();
  if (files.length > 7) {
    files.slice(0, files.length - 7).forEach(f => fs.unlinkSync(path.join(logsDir, f)));
  }
}

async function fetchLatestPrices() {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${FETCH_LIMIT}&convert=USD`;
  const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } });
  return res.data.data.map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    volume24h: c.quote.USD.volume_24h,
    marketCap: c.quote.USD.market_cap,
    percentChange24h: c.quote.USD.percent_change_24h
  }));
}

// Shared profit builder
async function buildProfitTable() {
  const persistence = loadPersistence();
  if (!persistence.date) {
    return "⚠️ No baseline set yet.";
  }

  const latest = await fetchLatestPrices();
  const profitList = [];

  for (const coin of latest) {
    const base = persistence.coins.find(c => c.symbol === coin.symbol);
    if (!base) continue;
    const change = ((coin.price - base.price) / base.price) * 100;
    profitList.push({
      symbol: coin.symbol,
      change,
      from: base.price,
      to: coin.price
    });
  }

  profitList.sort((a, b) => b.change - a.change);

  let msg = `📈 Profit since baseline (${persistence.date})\n`;
  profitList.slice(0, 10).forEach((p, i) => {
    msg += `${i + 1}. ${p.symbol} → ${p.change.toFixed(2)}% (from $${p.from.toFixed(2)} to $${p.to.toFixed(2)})\n`;
  });

  return msg || "⚠️ No data available.";
}

// ==========================
// Telegram
// ==========================
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));

bot.telegram.setWebhook(`${BASE_URL}/webhook`).then(() => {
  console.log(`✅ Webhook set to ${BASE_URL}/webhook`);
});

let autoProfit = { enabled: false, chatId: null };

// Commands
bot.start(ctx => {
  ctx.reply("👋 Welcome to Crypto Scanner Bot.\nUse /setbaseline to set a baseline.\nUse /profit to see profits.\nUse /top10 for predictions.\nUse /autoprofit to toggle auto mode.");
  writeLog(`/start by ${ctx.from.id}`);
});

bot.command("setbaseline", async ctx => {
  const prices = await fetchLatestPrices();
  const persistence = {
    date: new Date().toISOString().split("T")[0],
    setAt: new Date().toISOString(),
    coins: prices.map(c => ({ symbol: c.symbol, price: c.price }))
  };
  savePersistence(persistence);
  ctx.reply(`✅ Baseline set (manual) at ${new Date().toLocaleString()}\nDate: ${persistence.date}`);
  writeLog(`/setbaseline by ${ctx.from.id}`);
});

bot.command("profit", async ctx => {
  const msg = await buildProfitTable();
  ctx.reply(msg);
  writeLog(`/profit by ${ctx.from.id}`);
});

bot.command("autoprofit", async ctx => {
  autoProfit.enabled = !autoProfit.enabled;
  autoProfit.chatId = ctx.chat.id;
  ctx.reply(`🔄 Auto-profit is now ${autoProfit.enabled ? "ENABLED" : "DISABLED"} (every 5 minutes)`);
  writeLog(`/autoprofit by ${ctx.from.id} → ${autoProfit.enabled}`);
});

// ==========================
// Scheduler
// ==========================
schedule.scheduleJob("*/5 * * * *", async () => {
  if (autoProfit.enabled && autoProfit.chatId) {
    const msg = await buildProfitTable();
    await bot.telegram.sendMessage(autoProfit.chatId, `⏱ Auto-profit update:\n\n${msg}`);
    writeLog(`Auto-profit update sent`);
  }
});

// ==========================
// Start Server
// ==========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 Server listening on port ${PORT}`);
});