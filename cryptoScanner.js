const express = require("express");
const axios = require("axios");
const { BOT_TOKEN, CHAT_ID, REFRESH_INTERVAL } = require("./config");

const app = express();
const PORT = process.env.PORT || 3000; // Render requires dynamic port

let lastRun = null;

// ✅ Helper: Send message to Telegram
async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
    console.log("✅ Sent message to Telegram");
  } catch (err) {
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

// ✅ Helper: Fetch coins from CoinGecko
async function fetchTopCoins(limit = 20) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets`;
    const res = await axios.get(url, {
      params: {
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: limit,
        page: 1,
        sparkline: false
      }
    });
    return res.data;
  } catch (err) {
    console.error("❌ Error fetching top coins:", err.response?.data || err.message);
    return [];
  }
}

// ✅ Scanner function
async function runScanner() {
  console.log("🚀 Running Crypto Scanner...");
  lastRun = new Date();

  const coins = await fetchTopCoins(20);
  if (!coins || coins.length === 0) {
    console.log("⚠️ No coins fetched.");
    return;
  }

  let message = `🚀 Crypto Scanner Dashboard\n⏱️ Updated: ${new Date().toLocaleTimeString()}\n\n*Top 20 Coins:*\n`;

  coins.forEach((coin, i) => {
    const change = coin.price_change_percentage_24h?.toFixed(2) || "0.00";
    message += `${i + 1}. ${coin.symbol.toUpperCase()} (${coin.name}) - ${change}% - $${coin.current_price}\n`;
  });

  console.log(message);
  await sendTelegramMessage(message);
}

// ✅ Run scanner immediately and repeat
runScanner();
setInterval(runScanner, REFRESH_INTERVAL || 5 * 60 * 1000);

// ✅ Express server (for Render + health checks)
app.get("/", (req, res) => {
  res.send("✅ Crypto Scanner is running!");
});

app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    lastRun: lastRun ? lastRun.toISOString() : "not yet run"
  });
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});
