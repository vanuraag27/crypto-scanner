const express = require("express");
const axios = require("axios");
const { BOT_TOKEN, CHAT_ID, REFRESH_INTERVAL, CMC_API_KEY } = require("./config");

const app = express();
const PORT = process.env.PORT || 3000;

let lastRun = null;

// ✅ Send Telegram Message
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

// ✅ Fetch from CoinMarketCap
async function fetchTopCoins(limit = 20) {
  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest`;

    const res = await axios.get(url, {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: {
        start: 1,
        limit: limit,
        convert: "USD"
      }
    });

    return res.data.data;
  } catch (err) {
    console.error("❌ Error fetching top coins:", err.response?.data || err.message);
    return [];
  }
}

// ✅ Scanner
async function runScanner() {
  console.log("🚀 Running Crypto Scanner (CMC)...");
  lastRun = new Date();

  const coins = await fetchTopCoins(20);
  if (!coins || coins.length === 0) {
    console.log("⚠️ No coins fetched.");
    return;
  }

  let message = `🚀 *Crypto Scanner Dashboard*\n⏱️ Updated: ${new Date().toLocaleTimeString()}\n\n*Top 20 Coins (CMC):*\n`;

  coins.forEach((coin, i) => {
    const change = coin.quote.USD.percent_change_24h?.toFixed(2) || "0.00";
    const price = coin.quote.USD.price?.toFixed(4) || "0.00";
    message += `${i + 1}. ${coin.symbol} (${coin.name}) - ${change}% - $${price}\n`;
  });

  console.log(message);
  await sendTelegramMessage(message);
}

// ✅ Run immediately & repeat
runScanner();
setInterval(runScanner, REFRESH_INTERVAL);

// ✅ Health check
app.get("/", (req, res) => {
  res.send("✅ Crypto Scanner (CMC) is running!");
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
