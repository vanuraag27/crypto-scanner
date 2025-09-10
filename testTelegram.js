// cryptoScanner.js
const axios = require("axios");
const chalk = require("chalk");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");

const app = express();
const PORT = process.env.PORT || 10000;

const TELEGRAM_ENABLED = process.env.USE_TELEGRAM === "true";
const BOT_TOKEN = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;
const CMC_API_KEY = process.env.CMC_API_KEY || config.CMC_API_KEY;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL
  ? parseInt(process.env.REFRESH_INTERVAL)
  : 600000; // default 10 min

// ✅ Setup Telegram Bot (polling)
let bot = null;
if (TELEGRAM_ENABLED && BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log(chalk.yellow("🤖 Telegram bot polling enabled"));

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      "👋 Welcome! Crypto Scanner is live.\nYou'll automatically receive updates here."
    );
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      "ℹ️ Commands:\n/start - Register with the bot\n/help - Show this help\n/status - Show last scan\n/predict - Run a fresh scan now (Top 5 coins only)"
    );
  });

  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, lastStatusMessage || "⚠️ No scan yet.");
  });

  // ✅ New: Manual scan with /predict (Top 5 only)
  bot.onText(/\/predict/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "⏳ Running a fresh scan, please wait...");

    const coins = await fetchTopCoins();
    if (!coins.length) {
      bot.sendMessage(chatId, "❌ Failed to fetch coins. Try again later.");
      return;
    }

    const predictions = predictProfit(coins);

    const top5 = predictions.sort((a, b) => b.estProfit - a.estProfit).slice(0, 5);

    let output = "*🔥 Top 5 Predicted Movers (Next 24h)*\n";
    output += `⏱️ Updated: ${new Date().toLocaleTimeString()}\n\n`;

    top5.forEach((coin, i) => {
      output += `${i + 1}. ${coin.symbol} (${coin.name}) - $${coin.price.toFixed(
        4
      )} | 24h: ${coin.change.toFixed(2)}% | Est. Profit: ₹${coin.estProfit.toFixed(2)}\n`;
    });

    bot.sendMessage(chatId, output, { parse_mode: "Markdown" });
  });
}

// --- Global state ---
let lastStatusMessage = "";

// --- CMC API ---
async function fetchTopCoins() {
  try {
    const url =
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?start=1&limit=20&convert=USD";
    const res = await axios.get(url, {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
    });

    return res.data.data.map((coin) => ({
      symbol: coin.symbol,
      name: coin.name,
      price: coin.quote.USD.price,
      change: coin.quote.USD.percent_change_24h,
    }));
  } catch (err) {
    console.error("❌ Error fetching top coins:", err.response?.data || err.message);
    return [];
  }
}

// --- Prediction Logic (simple) ---
function predictProfit(coins) {
  return coins.map((coin) => {
    const estProfit = (coin.change / 100) * 10000; // assume ₹10k base
    return { ...coin, estProfit };
  });
}

// --- Telegram Sender ---
async function sendTelegramMessage(message) {
  if (!TELEGRAM_ENABLED || !BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ Telegram disabled or not configured");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    });
    console.log("📩 Telegram message sent successfully");
  } catch (err) {
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

// --- Scanner ---
async function runScan() {
  console.log("Starting scan...");
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  const predictions = predictProfit(coins);

  let output = "*🚀 Crypto Scanner Dashboard*\n";
  output += `⏱️ Updated: ${new Date().toLocaleTimeString()}\n\n`;
  predictions.forEach((coin, i) => {
    output += `${i + 1}. ${coin.symbol} - $${coin.price.toFixed(4)} | 24h: ${coin.change.toFixed(
      2
    )}% | Est. Profit: ₹${coin.estProfit.toFixed(2)}\n`;
  });

  console.log(output);
  lastStatusMessage = output;

  await sendTelegramMessage(output);
}

// --- Run First Scan ---
runScan();
setInterval(runScan, REFRESH_INTERVAL);

// --- Express Server ---
app.get("/", (req, res) => {
  res.send("🚀 Crypto Scanner is running");
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});
