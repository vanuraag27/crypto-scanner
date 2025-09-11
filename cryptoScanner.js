const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const config = require("./config");

const app = express();
app.use(express.json());

const BASELINE_FILE = "./baseline.json";

// --- Telegram ---
async function sendMessage(chatId, text, markdown = false) {
  if (!config.BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined
    });
  } catch (err) {
    console.error("❌ Telegram send error:", err.response?.data || err.message);
  }
}

// --- Baseline Helpers ---
function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return { date: "", coins: [] };
  return JSON.parse(fs.readFileSync(BASELINE_FILE));
}

function saveBaseline(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
}

// --- Fetch CMC data ---
async function fetchCoins(limit = 50) {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
        params: { start: 1, limit, convert: "USD" }
      }
    );
    return res.data.data.map(c => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h,
      volume: c.quote.USD.volume_24h
    }));
  } catch (err) {
    console.error("❌ Error fetching coins:", err.response?.data || err.message);
    return [];
  }
}

// --- Set Baseline ---
async function setBaseline(manual = false) {
  const coins = await fetchCoins(50);
  if (!coins.length) return;

  const top10 = coins
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  const baseline = {
    date: new Date().toLocaleDateString("en-IN"),
    coins: top10
  };

  saveBaseline(baseline);

  let msg = manual ? "✅ *Baseline refreshed manually*" : "✅ *Baseline set (6 AM IST)*";
  msg += `\nMonitoring top 10:\n`;
  top10.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
  });

  if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, msg, true);
  console.log(msg);
}

// --- Daily summary 10 PM IST ---
async function sendSummary() {
  const baseline = loadBaseline();
  if (!baseline.coins.length) return;

  const coins = await fetchCoins(50);
  if (!coins.length) return;

  const perf = baseline.coins.map(b => {
    const current = coins.find(c => c.symbol === b.symbol);
    if (!current) return null;
    const profitPct = ((current.price - b.price) / b.price) * 100;
    return { symbol: b.symbol, profitPct, price: current.price };
  }).filter(Boolean);

  perf.sort((a, b) => b.profitPct - a.profitPct);

  let msg = `📊 *Daily Summary (10 PM IST)*\n`;
  perf.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} → ${c.profitPct.toFixed(2)}% (Now: $${c.price.toFixed(2)})\n`;
  });

  if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, msg, true);
  console.log(msg);
}

// --- Alert system (-10% drop) ---
async function checkAlerts() {
  const baseline = loadBaseline();
  if (!baseline.coins.length) return;

  const coins = await fetchCoins(50);
  if (!coins.length) return;

  baseline.coins.forEach(b => {
    const current = coins.find(c => c.symbol === b.symbol);
    if (!current) return;
    const dropPct = ((current.price - b.price) / b.price) * 100;
    if (dropPct <= -10) {
      const msg = `⚠️ ALERT: ${b.symbol} dropped ${dropPct.toFixed(2)}%\nBaseline: $${b.price.toFixed(2)}\nNow: $${current.price.toFixed(2)}`;
      sendMessage(config.CHAT_ID, msg);
      console.log(msg);
    }
  });
}

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const baseline = loadBaseline();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use /top10, /profit, /status, /help");
  } else if (text === "/help") {
    await sendMessage(chatId, "📖 Commands:\n/top10 - Today’s baseline list\n/profit - Profit since 6AM baseline\n/status - Bot status\n/setbaseline - Refresh baseline (Admin only)\n/clearhistory - Clear baseline (Admin only)");
  } else if (text === "/status") {
    await sendMessage(chatId, "✅ Scanner is running");
  } else if (text === "/top10") {
    if (!baseline.coins.length) return sendMessage(chatId, "⚠️ Baseline not set yet.");
    let out = `📌 *Top 10 Baseline (${baseline.date})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline.coins.length) return sendMessage(chatId, "⚠️ Baseline not set yet.");
    const coins = await fetchCoins(50);
    const perf = baseline.coins.map(b => {
      const current = coins.find(c => c.symbol === b.symbol);
      if (!current) return null;
      const profitPct = ((current.price - b.price) / b.price) * 100;
      return { symbol: b.symbol, profitPct, price: current.price };
    }).filter(Boolean);
    perf.sort((a, b) => b.profitPct - a.profitPct);
    let out = `💹 *Profit Since 6AM Baseline*\n`;
    perf.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} → ${c.profitPct.toFixed(2)}% (Now: $${c.price.toFixed(2)})\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/setbaseline") {
    if (msg.from.id.toString() !== config.ADMIN_ID) return sendMessage(chatId, "⛔ Admin only.");
    await setBaseline(true);
  } else if (text === "/clearhistory") {
    if (msg.from.id.toString() !== config.ADMIN_ID) return sendMessage(chatId, "⛔ Admin only.");
    saveBaseline({ date: "", coins: [] });
    await sendMessage(chatId, "🗑️ Baseline cleared");
  }

  res.sendStatus(200);
});

// --- Scheduler ---
cron.schedule("0 6 * * *", () => setBaseline(false), { timezone: "Asia/Kolkata" });
cron.schedule("0 22 * * *", sendSummary, { timezone: "Asia/Kolkata" });
cron.schedule("*/30 * * * *", checkAlerts, { timezone: "Asia/Kolkata" }); // every 30 mins

// --- Startup ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");

  const baseline = loadBaseline();
  if (!baseline.coins.length) {
    console.log("⚠️ No baseline found. Creating one now...");
    await setBaseline(false);
  }
});
