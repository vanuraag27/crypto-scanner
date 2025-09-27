import express from "express";
import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs";
import path from "path";
import schedule from "node-schedule";
import { fileURLToPath } from "url";
import { format } from "date-fns-tz";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === ENVIRONMENT VARIABLES ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const CMC_API_KEY = process.env.CMC_API_KEY;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");

// === FILE PATHS ===
const dataFile = path.join(__dirname, "data.json");
const alertsFile = path.join(__dirname, "alerts.json");

// === STATE ===
let baseline = { date: null, setAt: null, coins: [] };
let alerts = [];
let autoProfit = false;
let autoProfitJob = null;

// === UTILS ===
function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`Error reading ${file}:`, e);
  }
  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${file}:`, e);
  }
}

function nowIST() {
  return format(new Date(), "dd/MM/yyyy, hh:mm:ss a", { timeZone: "Asia/Kolkata" });
}

// === INITIAL LOAD ===
baseline = loadJSON(dataFile, baseline);
alerts = loadJSON(alertsFile, []);

// === TELEGRAM BOT ===
const bot = new Telegraf(TELEGRAM_TOKEN);

// Start command
bot.start((ctx) => {
  ctx.reply("👋 Welcome! You will receive crypto scanner updates here.\n\n" +
    "📌 Commands:\n" +
    "/help - show this message\n" +
    "/status - scanner & baseline status\n" +
    "/top10 - show baseline coins\n" +
    "/profit - show profit since baseline\n" +
    "/alerts - list alerts\n" +
    "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
    "/clearhistory - admin clear alerts\n" +
    "/autoprofit on|off - toggle auto-profit updates\n" +
    "/forcealert SYMBOL - admin simulate an alert");
});

// Help command
bot.command("help", (ctx) => {
  ctx.reply("📌 Commands:\n" +
    "/start - register chat\n" +
    "/status - scanner & baseline status\n" +
    "/top10 - show baseline coins\n" +
    "/profit - show profit since baseline\n" +
    "/alerts - list alerts\n" +
    "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
    "/clearhistory - admin clear alerts\n" +
    "/autoprofit on|off - toggle auto-profit updates\n" +
    "/forcealert SYMBOL - admin simulate an alert");
});

// Status
bot.command("status", (ctx) => {
  ctx.reply(`📊 Baseline date: [${baseline.date || "N/A"}]\nSet at: ${baseline.setAt || "N/A"}\nCoins tracked: ${baseline.coins.length}`);
});

// Top 10
bot.command("top10", (ctx) => {
  if (!baseline.date || baseline.coins.length === 0) {
    return ctx.reply("⚠️ No baseline set yet.");
  }
  let msg = `📊 Baseline Top 10 (day: ${baseline.date})\n`;
  baseline.coins.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} — $${c.priceUSD.toFixed(4)} (₹${c.priceINR.toFixed(2)})\n`;
  });
  ctx.reply(msg);
});

// Profit
bot.command("profit", async (ctx) => {
  if (!baseline.date || baseline.coins.length === 0) {
    return ctx.reply("⚠️ No baseline set yet.");
  }
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50&convert=USD,INR", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
    });
    const latest = res.data.data;
    const lines = baseline.coins.map((c) => {
      const cur = latest.find((x) => x.symbol === c.symbol);
      if (!cur) return `${c.symbol} → data missing`;
      const pct = ((cur.quote.USD.price - c.priceUSD) / c.priceUSD) * 100;
      return `${c.symbol} → ${pct.toFixed(2)}% (from $${c.priceUSD.toFixed(2)} to $${cur.quote.USD.price.toFixed(2)})`;
    });
    ctx.reply("📈 Profit since baseline (" + baseline.date + ")\n" + lines.join("\n"));
  } catch (e) {
    console.error("Profit fetch error:", e.message);
    ctx.reply("❌ Error fetching prices.");
  }
});

// Alerts
bot.command("alerts", (ctx) => {
  if (alerts.length === 0) return ctx.reply("🔔 No alerts triggered for current baseline.");
  let msg = `🔔 Alerts (baseline ${baseline.date}):\n`;
  alerts.forEach((a) => {
    msg += `${a.symbol} dropped ${a.drop}% at ${a.time}\n`;
  });
  ctx.reply(msg);
});

// Set baseline
bot.command("setbaseline", async (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) {
    return ctx.reply("⛔ Admin only.");
  }
  const parts = ctx.message.text.split(" ");
  let dateStr = parts[1] || format(new Date(), "yyyy-MM-dd", { timeZone: "Asia/Kolkata" });
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50&convert=USD,INR", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
    });
    const coins = res.data.data.map((c) => ({
      symbol: c.symbol,
      priceUSD: c.quote.USD.price,
      priceINR: c.quote.INR.price
    }));
    baseline = { date: dateStr, setAt: nowIST(), coins };
    saveJSON(dataFile, baseline);
    alerts = [];
    saveJSON(alertsFile, alerts);
    ctx.reply(`✅ Baseline set (manual) at ${nowIST()}\nDate: [${dateStr}]\nTop 10 recorded.`);
  } catch (e) {
    console.error("SetBaseline error:", e.message);
    ctx.reply("❌ Error fetching baseline data.");
  }
});

// Clear history
bot.command("clearhistory", (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("⛔ Admin only.");
  alerts = [];
  saveJSON(alertsFile, alerts);
  ctx.reply("🧹 Alerts history cleared for today.");
});

// AutoProfit toggle
bot.command("autoprofit", (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (!arg) return ctx.reply("Usage: /autoprofit on|off");
  if (arg.toLowerCase() === "on") {
    autoProfit = true;
    if (autoProfitJob) autoProfitJob.cancel();
    autoProfitJob = schedule.scheduleJob("*/5 * * * *", async () => {
      try {
        const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50&convert=USD,INR", {
          headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
        });
        const latest = res.data.data;
        const lines = baseline.coins.map((c) => {
          const cur = latest.find((x) => x.symbol === c.symbol);
          if (!cur) return `${c.symbol} → data missing`;
          const pct = ((cur.quote.USD.price - c.priceUSD) / c.priceUSD) * 100;
          return `${c.symbol} → ${pct.toFixed(2)}% (from $${c.priceUSD.toFixed(2)} to $${cur.quote.USD.price.toFixed(2)})`;
        });
        bot.telegram.sendMessage(CHAT_ID, "⏱ Auto-profit update:\n" + lines.join("\n"));
      } catch (e) {
        console.error("AutoProfit error:", e.message);
      }
    });
    ctx.reply("🔄 Auto-profit updates enabled (every 5 minutes).");
  } else {
    autoProfit = false;
    if (autoProfitJob) autoProfitJob.cancel();
    ctx.reply("⏹ Auto-profit updates disabled.");
  }
});

// ForceAlert (new)
bot.command("forcealert", (ctx) => {
  if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("⛔ Admin only.");
  const parts = ctx.message.text.split(" ");
  if (!parts[1]) return ctx.reply("Usage: /forcealert SYMBOL");
  const sym = parts[1].toUpperCase();
  const coin = baseline.coins.find((c) => c.symbol === sym);
  if (!coin) return ctx.reply(`❌ Symbol ${sym} not found in baseline.`);
  const fakeDrop = ALERT_DROP_PERCENT;
  const fakePrice = coin.priceUSD * (1 + fakeDrop / 100);
  const alertObj = {
    symbol: sym,
    drop: fakeDrop,
    baseline: coin.priceUSD,
    current: fakePrice,
    time: nowIST(),
  };
  alerts.push(alertObj);
  saveJSON(alertsFile, alerts);
  ctx.reply(`🔔 ALERT (forced):\n${sym} dropped ${fakeDrop}%\nBaseline: $${coin.priceUSD.toFixed(2)}\nCurrent: $${fakePrice.toFixed(2)}\nTime: ${alertObj.time}`);
});

// === EXPRESS SERVER ===
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${process.env.BASE_URL}/webhook`);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 Server listening on port ${PORT}`);
});