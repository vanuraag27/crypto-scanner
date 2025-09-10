const express = require("express");
const axios = require("axios");
const config = require("./config");

const app = express();
app.use(express.json());

let lastUpdateTime = null;
let lastPrediction = null;

// --- Auto Webhook Setup ---
async function setWebhook() {
  if (!config.BOT_TOKEN) return;
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    console.log(`✅ Webhook set: ${webhookUrl}`);
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
}

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message?.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(
      chatId,
      "👋 Welcome! You’ll now receive *Crypto Scanner* updates.\n\nCommands:\n`/status` → Check scanner\n`/predict` → Get top 10 profitable coins\n`/help` → Help menu",
      true
    );
  } else if (text === "/status") {
    await sendMessage(
      chatId,
      `✅ Scanner running.\n⏱️ Last update: ${lastUpdateTime || "Not yet"}`,
      false
    );
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 *Available Commands:*\n\n/start - Start updates\n/status - Scanner status\n/predict - Show latest top 10 predictions\n/help - Help menu",
      true
    );
  } else if (text === "/predict") {
    if (lastPrediction) {
      await sendMessage(chatId, lastPrediction, true);
    } else {
      await sendMessage(chatId, "⚠️ No predictions yet. Please wait for the first scan.", false);
    }
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Use `/help`.", false);
  }

  res.sendStatus(200);
});

// --- Telegram Sender ---
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

// --- Prediction Logic ---
async function runScanner() {
  console.log("🔍 Starting scan...");
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
        params: { start: 1, limit: 50, convert: "USD" }
      }
    );

    const coins = res.data.data;
    lastUpdateTime = new Date().toLocaleTimeString();

    const predictions = coins
      .map((coin) => {
        const usdChange = coin.quote.USD.percent_change_24h;
        const inrProfit = (usdChange / 100) * 100 * config.INR_RATE;
        return {
          name: coin.name,
          symbol: coin.symbol,
          price: coin.quote.USD.price,
          change24h: usdChange,
          profitInr: inrProfit
        };
      })
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 10);

    let output = `*🚀 Top 10 Predicted Profitable Coins (Next 24h)*\n⏱️ Updated: ${lastUpdateTime}\n\n`;
    predictions.forEach((c, i) => {
      output += `${i + 1}. ${c.symbol} (${c.name}) → $${c.price.toFixed(4)} | 24h: ${c.change24h.toFixed(2)}% | Est. Profit: ₹${c.profitInr.toFixed(2)}\n`;
    });

    lastPrediction = output;

    if (config.USE_TELEGRAM && config.CHAT_ID) {
      await sendMessage(config.CHAT_ID, output, true);
      console.log("📩 Telegram message sent successfully");
    } else {
      console.log(output);
    }
  } catch (err) {
    console.error("❌ Error fetching data:", err.response?.data || err.message);
  }

  setTimeout(runScanner, config.REFRESH_INTERVAL);
}

// --- Start Express ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();
  runScanner();
});
