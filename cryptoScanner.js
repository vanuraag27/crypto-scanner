const express = require("express");
const axios = require("axios");
const path = require("path");
require('dotenv').config(); // For local development

const app = express();
const PORT = process.env.PORT || 3000;

// Get configuration from environment variables (with fallbacks)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 300000; // 5 minutes
const CMC_API_KEY = process.env.CMC_API_KEY;

let lastRun = null;
let topCoins = [];

// Serve static files (for potential frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ✅ Send Telegram Message with improved error handling
async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️  Telegram not configured - skipping notification");
    return;
  }

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
    
    // Provide more specific error information
    if (err.response?.status === 404) {
      console.error("This usually means:");
      console.error("1. Your BOT_TOKEN is incorrect");
      console.error("2. Your CHAT_ID is incorrect");
      console.error("3. The bot hasn't been started with /start");
    }
  }
}

// ✅ Fetch from CoinMarketCap with better error handling
async function fetchTopCoins(limit = 20) {
  if (!CMC_API_KEY) {
    console.error("❌ CMC_API_KEY is not configured");
    return [];
  }

  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest`;

    const res = await axios.get(url, {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: {
        start: 1,
        limit: limit,
        convert: "USD"
      },
      timeout: 10000 // 10 second timeout
    });

    return res.data.data;
  } catch (err) {
    console.error("❌ Error fetching top coins:", err.message);
    
    if (err.response?.status === 401) {
      console.error("CMC API key is invalid");
    } else if (err.response?.status === 429) {
      console.error("CMC API rate limit exceeded");
    } else if (err.code === 'ECONNABORTED') {
      console.error("CMC API request timed out");
    }
    
    return [];
  }
}

// ✅ Format price with appropriate decimal places
function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(8);
}

// ✅ Scanner
async function runScanner() {
  console.log("🚀 Running Crypto Scanner (CMC)...");
  lastRun = new Date();

  const coins = await fetchTopCoins(20);
  if (!coins || coins.length === 0) {
    console.log("⚠️ No coins fetched. Using previous data if available.");
    return;
  }

  // Store for API access
  topCoins = coins;

  let message = `🚀 *Crypto Scanner Dashboard*\n⏱️ Updated: ${new Date().toLocaleTimeString()}\n\n*Top 20 Coins (CMC):*\n`;

  coins.forEach((coin, i) => {
    const change = coin.quote.USD.percent_change_24h?.toFixed(2) || "0.00";
    const price = formatPrice(coin.quote.USD.price || 0);
    const changeIcon = change >= 0 ? '📈' : '📉';
    message += `${i + 1}. ${coin.symbol} (${coin.name}) - ${change}% ${changeIcon} - $${price}\n`;
  });

  console.log(message);
  await sendTelegramMessage(message);
}

// ✅ Run immediately & repeat
runScanner();
setInterval(runScanner, REFRESH_INTERVAL);

// ✅ API endpoints
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Crypto Scanner</title>
        <meta http-equiv="refresh" content="60">
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .coin { padding: 10px; border-bottom: 1px solid #eee; }
          .positive { color: green; }
          .negative { color: red; }
        </style>
      </head>
      <body>
        <h1>🚀 Crypto Scanner Dashboard</h1>
        <p>⏱️ Last Updated: ${lastRun ? lastRun.toLocaleTimeString() : 'Never'}</p>
        <div id="coins">
          ${topCoins.map((coin, i) => {
            const change = coin.quote.USD.percent_change_24h?.toFixed(2) || "0.00";
            const isPositive = change >= 0;
            return `
              <div class="coin">
                <b>${i + 1}. ${coin.name} (${coin.symbol})</b>
                <span class="${isPositive ? 'positive' : 'negative'}">
                  ${change}% ${isPositive ? '📈' : '📉'} - $${formatPrice(coin.quote.USD.price || 0)}
                </span>
              </div>
            `;
          }).join('')}
        </div>
        <p><a href="/json">View as JSON</a> | <a href="/healthz">Health Check</a></p>
      </body>
    </html>
  `);
});

app.get("/json", (req, res) => {
  res.json({
    status: "ok",
    lastRun: lastRun ? lastRun.toISOString() : "not yet run",
    coins: topCoins
  });
});

app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    lastRun: lastRun ? lastRun.toISOString() : "not yet run",
    telegramConfigured: !!(BOT_TOKEN && CHAT_ID),
    cmcConfigured: !!CMC_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
  console.log(`⚠️  Telegram notifications: ${BOT_TOKEN && CHAT_ID ? 'ENABLED' : 'DISABLED'}`);
  console.log(`⚠️  CMC API: ${CMC_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
});
