const axios = require("axios");
const chalk = require("chalk");
const express = require("express");
const config = require("./config");

const PORT = process.env.PORT || 10000;
const INVEST_AMOUNT = parseInt(process.env.INVEST_AMOUNT) || 10000;
const USE_TELEGRAM = process.env.USE_TELEGRAM === "true";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;

const app = express();

async function fetchTopCoins() {
  try {
    console.log("Fetching top 20 coins from CMC...");
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": process.env.CMC_API_KEY || config.CMC_API_KEY },
      params: { start: 1, limit: 20, convert: "USD" }
    });

    return res.data.data;
  } catch (err) {
    console.error("❌ Error fetching top coins:", err.response?.data || err.message);
    return [];
  }
}

function predictProfit(priceChange) {
  return ((INVEST_AMOUNT * priceChange) / 100).toFixed(2);
}

async function sendTelegram(message) {
  if (!USE_TELEGRAM || !TELEGRAM_TOKEN || !CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message
    });
    console.log("📩 Telegram message sent successfully");
  } catch (err) {
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

async function main() {
  console.log("🚀 Running Crypto Scanner (CMC)...");
  console.log("⚠️ Telegram notifications:", USE_TELEGRAM ? "ENABLED" : "DISABLED");
  console.log("⚠️ CMC API:", process.env.CMC_API_KEY ? "CONFIGURED" : "MISSING");

  app.get("/", (req, res) => res.send("Crypto Scanner is running!"));
  app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));

  console.log("Starting scan...");
  const coins = await fetchTopCoins();

  if (!coins.length) {
    console.log("⚠️ No coins fetched.");
    return;
  }

  console.log("Fetched top 20 coins successfully");
  console.log("Predicting top coins...");

  let message = `📊 *Crypto Scanner Report*\n💰 Investment: ₹${INVEST_AMOUNT}\n\n`;

  coins.forEach((coin, i) => {
    const symbol = coin.symbol;
    const price = coin.quote.USD.price.toFixed(4);
    const change = coin.quote.USD.percent_change_24h.toFixed(2);
    const profit = predictProfit(change);

    const line = `${i + 1}. ${symbol} - $${price} | 24h: ${change}% | Est. Profit: ₹${profit}`;
    console.log(line);
    message += line + "\n";
  });

  console.log("Prediction completed");
  console.log("Scan completed");

  // ✅ Send report to Telegram
  if (USE_TELEGRAM) {
    await sendTelegram(message);
  }
}

main();
