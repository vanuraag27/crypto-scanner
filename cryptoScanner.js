import fs from "fs";
import axios from "axios";
import express from "express";
import schedule from "node-schedule";
import { Telegraf } from "telegraf";
import { rotateLogs } from "./logs/rotate.js";

// === CONFIG ===
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000", 10);
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0", 10);
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const CMC_API_KEY = process.env.CMC_API_KEY;

const DATA_FILE = "data.json";
const ALERTS_FILE = "alerts.json";

function log(msg) {
  const stamp = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(stamp);
  const logFile = `logs/${new Date().toISOString().split("T")[0]}.log`;
  fs.appendFileSync(logFile, stamp + "\n");
  rotateLogs();
}

// === Persistence ===
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { date: null, setAt: null, coins: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
function loadAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ALERTS_FILE));
}
function saveAlerts(a) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(a, null, 2));
}

// === Telegram Bot ===
const bot = new Telegraf(TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n" +
      "📌 Commands:\n" +
      "/help - show this message\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show baseline coins\n" +
      "/profit - show profit since baseline\n" +
      "/alerts - list alerts\n" +
      "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
      "/clearhistory - admin clear alerts\n" +
      "/autoprofit on|off - toggle auto-profit updates"
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "📌 Commands:\n" +
      "/start - register chat\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show baseline coins\n" +
      "/profit - show profit since baseline\n" +
      "/alerts - list alerts\n" +
      "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
      "/clearhistory - admin clear alerts\n" +
      "/autoprofit on|off - toggle auto-profit updates"
  );
});

// === Alerts ===
bot.command("alerts", async (ctx) => {
  const alerts = loadAlerts();
  const data = loadData();
  if (!alerts.length) return ctx.reply("🔔 No alerts triggered for current baseline.");

  let msg = `🔔 Alerts for baseline (${data.date || "N/A"}):\n\n`;

  for (const alert of alerts) {
    const base = data.coins.find((c) => c.symbol === alert.symbol);

    try {
      const res = await axios.get(
        "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest",
        {
          headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
          params: { symbol: alert.symbol, convert: "USD,INR" },
        }
      );
      const current = res.data.data[alert.symbol];

      if (base && current) {
        const change =
          ((current.quote.USD.price - base.quote.USD.price) /
            base.quote.USD.price) *
          100;

        msg += `${alert.symbol}\n` +
               `• Baseline: $${base.quote.USD.price.toFixed(2)} | ₹${base.quote.INR?.price.toFixed(2)}\n` +
               `• Current:  $${current.quote.USD.price.toFixed(2)} | ₹${current.quote.INR?.price.toFixed(2)}\n` +
               `• Change: ${change.toFixed(2)}%\n` +
               `• Alerted at: ${new Date(alert.time).toLocaleTimeString()}\n\n`;
      }
    } catch {
      msg += `${alert.symbol} — baseline $${base?.quote.USD.price.toFixed(
        2
      )} | error fetching current price\n\n`;
    }
  }

  ctx.reply(msg);
});

// === Express & Webhook ===
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`🌍 Server listening on port ${PORT}`);
  log(`✅ Webhook set to ${BASE_URL}/webhook`);
});