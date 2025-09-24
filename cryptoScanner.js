/**
 * cryptoScanner.js
 * Telegram crypto scanner with baseline, alerts, and daily summary
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Telegraf } = require("telegraf");
const schedule = require("node-schedule");

// --- Environment Variables ---
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

if (!TOKEN || !BASE_URL || !CMC_API_KEY) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// --- Helpers ---
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayDateIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // yyyy-mm-dd
}

// --- Persistence ---
const persistenceFile = path.join(__dirname, "data.json");
let persistence = {
  date: null,
  setAt: null,
  coins: [],
};

function savePersistence() {
  fs.writeFileSync(persistenceFile, JSON.stringify(persistence, null, 2));
}
function loadPersistence() {
  if (fs.existsSync(persistenceFile)) {
    persistence = JSON.parse(fs.readFileSync(persistenceFile));
  }
  console.log(`[${nowIST()}] Loaded persistence:`, persistence);
}
loadPersistence();

// Alerts persistence
const alertsFile = path.join(__dirname, "alerts.json");
let alertedSymbols = [];
function saveAlerts() {
  fs.writeFileSync(alertsFile, JSON.stringify(alertedSymbols, null, 2));
}
function loadAlerts() {
  if (fs.existsSync(alertsFile)) {
    alertedSymbols = JSON.parse(fs.readFileSync(alertsFile));
  }
}
loadAlerts();

// --- Telegram Bot ---
const bot = new Telegraf(TOKEN);

// Register /start
bot.start((ctx) => {
  const id = ctx.chat.id;
  persistence.savedChat = id;
  savePersistence();
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/start - register this chat\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show today's baseline list\n" +
      "/profit - ranked % profit since baseline\n" +
      "/alerts - list current alerts\n" +
      "/setbaseline - admin only, force baseline now\n" +
      "/clearhistory - admin only, clears alerts"
  );
});

// --- Fetch Coin Data ---
async function fetchTopCoins() {
  const res = await axios.get(
    "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
    {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit: FETCH_LIMIT, convert: "USD" },
    }
  );
  return res.data.data.map((c) => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h,
    volume: c.quote.USD.volume_24h,
    marketCap: c.quote.USD.market_cap,
  }));
}

// --- Baseline Management ---
async function setBaseline(manual = false) {
  const coins = await fetchTopCoins();
  const filtered = coins
    .filter(
      (c) =>
        c.change >= 20 && c.volume >= 50_000_000 && c.marketCap >= 500_000_000
    )
    .slice(0, 10);

  persistence.date = todayDateIST();
  persistence.setAt = nowIST();
  persistence.coins = filtered;
  savePersistence();

  alertedSymbols = [];
  saveAlerts();

  const msg = `✅ Baseline set (${manual ? "manual" : "auto"}) at ${
    persistence.setAt
  }\nMonitoring top 10:\n${filtered
    .map(
      (c, i) =>
        `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(
          2
        )}%)`
    )
    .join("\n")}`;

  await bot.telegram.sendMessage(CHAT_ID, msg);
  console.log(msg);
}

// --- Commands ---
bot.command("status", (ctx) => {
  ctx.reply(
    `✅ Scanner running.\nBaseline day: ${
      persistence.date || "Not set"
    }\nBaseline set at: ${persistence.setAt || "N/A"}\nActive alerts today: ${
      alertedSymbols.length
    }\nChecked at: ${nowIST()}`
  );
});

bot.command("top10", (ctx) => {
  if (!persistence.date)
    return ctx.reply("⚠️ Baseline not set yet. Wait until 6 AM IST or /setbaseline.");
  ctx.reply(
    `📊 Baseline Top 10 (day: ${persistence.date})\nBaseline set at: ${
      persistence.setAt
    }\n\n${persistence.coins
      .map(
        (c, i) =>
          `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(
            2
          )}%)`
      )
      .join("\n")}`
  );
});

bot.command("profit", async (ctx) => {
  if (!persistence.date) return ctx.reply("⚠️ Baseline not set yet.");
  const live = await fetchTopCoins();
  const report = persistence.coins
    .map((base) => {
      const cur = live.find((c) => c.symbol === base.symbol);
      if (!cur) return null;
      const diff = ((cur.price - base.price) / base.price) * 100;
      return `${base.symbol} → ${diff.toFixed(2)}% (from $${base.price.toFixed(
        4
      )} to $${cur.price.toFixed(4)})`;
    })
    .filter(Boolean)
    .join("\n");

  ctx.reply(
    `📈 Profit since baseline (${persistence.date})\n` +
      `Baseline set at: ${persistence.setAt}\n` +
      `Last checked at: ${nowIST()}\n\n${report}`
  );
});

bot.command("alerts", (ctx) => {
  ctx.reply(
    `🔔 Alerts for baseline ${persistence.date || "N/A"}\n` +
      `Baseline set at: ${persistence.setAt || "N/A"}\n` +
      `Last checked at: ${nowIST()}\n\n` +
      (alertedSymbols.length ? alertedSymbols.join(", ") : "None")
  );
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("❌ Admin only command.");
  await setBaseline(true);
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("❌ Admin only command.");
  alertedSymbols = [];
  saveAlerts();
  ctx.reply("✅ Alerts cleared for today.");
});

// --- Alert Monitoring ---
async function checkAlerts() {
  if (!persistence.date || !persistence.coins.length) return;
  const live = await fetchTopCoins();
  for (let base of persistence.coins) {
    const cur = live.find((c) => c.symbol === base.symbol);
    if (!cur) continue;
    const diff = ((cur.price - base.price) / base.price) * 100;
    if (diff <= ALERT_DROP_PERCENT && !alertedSymbols.includes(base.symbol)) {
      alertedSymbols.push(base.symbol);
      saveAlerts();
      const msg = `⚠️ Alert: ${base.symbol} dropped ${diff.toFixed(
        2
      )}%\nBaseline: $${base.price.toFixed(
        4
      )}\nCurrent: $${cur.price.toFixed(4)}\nTime: ${nowIST()}`;
      await bot.telegram.sendMessage(CHAT_ID, msg);
      console.log(msg);
    }
  }
}

// --- Scheduler ---
schedule.scheduleJob(
  { hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" },
  () => setBaseline(false)
);

// Monitoring loop
setInterval(checkAlerts, REFRESH_INTERVAL);

// --- Express Server ---
const app = express();
app.use(express.json());
app.use(bot.webhookCallback("/webhook"));

bot.telegram.setWebhook(`${BASE_URL}/webhook`).then(() => {
  console.log(`[${nowIST()}] ✅ Webhook set to ${BASE_URL}/webhook`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${nowIST()}] 🌍 Server listening on port ${PORT}`);
  console.log(
    `[${nowIST()}] Configuration: BASELINE ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | REFRESH_INTERVAL ${REFRESH_INTERVAL}ms | ALERT_DROP_PERCENT ${ALERT_DROP_PERCENT}%`
  );
  if (!persistence.date) {
    console.log(
      `[${nowIST()}] ⚠️ No baseline set yet. Will auto-create at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin can run /setbaseline.`
    );
  }
});