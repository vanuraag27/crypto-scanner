const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const config = require("./config");
const chalk = require("chalk");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Telegram webhook endpoint
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "🚀 Welcome! You will receive crypto scanner updates here.");
  }

  res.sendStatus(200);
});

async function sendMessage(chatId, text) {
  if (!config.BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text
    });
    console.log(chalk.green("📩 Telegram message sent successfully"));
  } catch (err) {
    console.error("❌ Telegram send error:", err.response?.data || err.message);
  }
}

async function fetchTopCoins() {
  try {
    const resp = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      params: { start: 1, limit: 20, convert: "USD" },
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY }
    });
    return resp.data.data || [];
  } catch (err) {
    console.error("❌ Error fetching coins:", err.response?.data || err.message);
    return [];
  }
}

async function scanAndNotify() {
  console.log("Starting scan...");
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  let text = "*🚀 Crypto Scanner Dashboard*\n";
  text += `⏱️ Updated: ${new Date().toLocaleTimeString()}\n`;

  coins.forEach((coin, i) => {
    const price = coin.quote.USD.price.toFixed(4);
    const change = coin.quote.USD.percent_change_24h.toFixed(2);
    const estProfit = (coin.quote.USD.percent_change_24h * 100).toFixed(2);
    text += `${i + 1}. ${coin.symbol} - $${price} | 24h: ${change}% | Est. Profit: ₹${estProfit}\n`;
  });

  console.log(text);

  if (config.USE_TELEGRAM && config.CHAT_ID) {
    await sendMessage(config.CHAT_ID, text);
  }
}

// Schedule scan
setInterval(scanAndNotify, config.REFRESH_INTERVAL);
scanAndNotify();

app.listen(PORT, async () => {
  console.log(`🌍 Server running on port ${PORT}`);
  console.log(chalk.cyan("Webhook mode enabled — set this URL in Telegram:"));
  console.log(`👉 https://crypto-scanner-jaez.onrender.com/webhook`);
});
