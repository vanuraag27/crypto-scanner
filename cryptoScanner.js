// cryptoScanner.js
require('dotenv').config(); // Added to load .env file
const axios = require("axios");
const chalk = require("chalk");
const express = require("express");
const config = require("./config");

// Prioritize environment variables for security
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;
const CMC_API_KEY = process.env.CMC_API_KEY;

// --- State ---
let cachedHistory = new Map(); // Store 7-day history with timestamp
let predictedCoins = new Set();
let lastPredictionTime = 0;
let currentTop20 = []; // Store latest data for web serving

// --- Delay helper ---
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Telegram ---
async function sendTelegram(message) {
  if (!config.USE_TELEGRAM || !TELEGRAM_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message
    });
  } catch (err) {
    console.error("Telegram error:", err.response ? err.response.data : err.message);
  }
}

// --- Fetch top 20 coins (CMC API) ---
async function fetchTopCoins() {
  if (!CMC_API_KEY) {
    console.error("CMC API key not set.");
    return [];
  }
  try {
    const { data } = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      params: {
        start: 1,
        limit: 20,
        convert: "USD"
      },
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
    });
    return data.data.map(coin => ({
      id: coin.slug,
      symbol: coin.symbol,
      name: coin.name,
      current_price: coin.quote.USD.price,
      price_change_percentage_24h: coin.quote.USD.percent_change_24h,
      market_cap_rank: coin.cmc_rank
    }));
  } catch (err) {
    console.error("Error fetching top coins:", err.response ? err.response.data : err.message);
    return [];
  }
}

// --- Fetch 7-day history with caching (CMC API) ---
async function fetch7DayHistory(symbol) {
  const now = Date.now();
  const cache = cachedHistory.get(symbol);

  if (cache && now - cache.timestamp < 30 * 60 * 1000) {
    return cache.prices;
  }

  try {
    const sevenDaysAgo = Math.floor((now - 7 * 24 * 60 * 60 * 1000) / 1000);
    const { data } = await axios.get(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/ohlcv/historical`,
      {
        params: { symbol: symbol.toUpperCase(), time_start: sevenDaysAgo, time_end: Math.floor(now / 1000), interval: "daily" },
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY }
      }
    );
    await delay(1500); // Avoid rate limit
    const prices = data.data.quotes.map(q => q.quote.USD.close);
    cachedHistory.set(symbol, { prices, timestamp: now });
    return prices;
  } catch (err) {
    console.error(`Error fetching 7-day history for ${symbol}:`, err.response ? err.response.data : err.message);
    return [];
  }
}

// --- Estimate 24h move ---
function estimateNext24hMove(prices) {
  if (!prices || prices.length < 2) return 0;
  let totalChange = 0;
  for (let i = 1; i < prices.length; i++) {
    totalChange += Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return (totalChange / (prices.length - 1)) * 100;
}

// --- Predict top coins (every 30 minutes) ---
async function predictTopCoins(coins) {
  const now = Date.now();
  if (now - lastPredictionTime < 30 * 60 * 1000) return;

  const predictions = [];
  for (const coin of coins) {
    const prices = await fetch7DayHistory(coin.symbol);
    const predictedMove = estimateNext24hMove(prices);
    predictions.push({ ...coin, predictedMove });
  }

  predictions.sort((a, b) => b.predictedMove - a.predictedMove);
  const topPredicted = predictions.slice(0, config.PREDICTION_TOP_N);

  predictedCoins.clear();
  topPredicted.forEach(c => predictedCoins.add(c.id));

  const message = topPredicted
    .map(c => {
      const move = c.predictedMove !== undefined ? c.predictedMove.toFixed(2) : "N/A";
      return `${c.symbol.toUpperCase()} (${c.name}): ±${move}%`;
    })
    .join("\n");

  await sendTelegram(`🔮 Top ${config.PREDICTION_TOP_N} Coins Likely to Move Next 24h:\n\n${message}`);
  lastPredictionTime = now;
}

// --- Generate HTML dashboard ---
function generateHTMLDashboard(top20) {
  let html = `<h1>🚀 Crypto Scanner Dashboard</h1>`;
  html += `<p>⏱️ Updated: ${new Date().toLocaleTimeString()}</p>`;

  html += `<h2>Predicted Top Movers (Next 24h):</h2><ul>`;
  top20.filter(c => predictedCoins.has(c.id)).forEach(c => {
    const move = c.predictedMove !== undefined ? c.predictedMove.toFixed(2) : "N/A";
    html += `<li>🔮 ${c.symbol.toUpperCase()} (${c.name}): ±${move}%</li>`;
  });
  html += `</ul>`;

  html += `<h2>Top 20 Coins by 24h Change:</h2><ol>`;
  top20.forEach(coin => {
    const change = coin.price_change_percentage_24h !== undefined ? coin.price_change_percentage_24h.toFixed(2) : "N/A";
    const price = coin.current_price !== undefined ? coin.current_price.toFixed(4) : "N/A";
    const direction = parseFloat(change) > 0 ? '📈' : '📉';
    let line = `${coin.symbol.toUpperCase()} (${coin.name}) ${change}% ${direction} - $${price}`;
    if (coin.price_change_percentage_24h >= config.ALERT_10_PERCENT_THRESHOLD) line += " 🚀";
    if (coin.price_change_percentage_24h <= -config.ALERT_10_PERCENT_THRESHOLD) line += " 🔻";
    html += `<li>${line}</li>`;
  });
  html += `</ol>`;

  html += `<a href="/json">View as JSON</a> | <a href="/health">Health Check</a>`;
  return html;
}

// --- Main scan loop ---
async function scan() {
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  await predictTopCoins(coins);
  currentTop20 = coins; // Update for web serving
}

// --- Start scanner and web server ---
async function start() {
  console.log("🚀 Running Crypto Scanner (CMC)...");
  console.log(`⚠️ Telegram notifications: ${TELEGRAM_TOKEN && CHAT_ID ? "ENABLED" : "DISABLED"}`);
  console.log(`⚠️ CMC API: ${CMC_API_KEY ? "CONFIGURED" : "NOT CONFIGURED"}`);

  const app = express();
  const port = process.env.PORT || 10000;

  app.get("/", (req, res) => {
    res.send(generateHTMLDashboard(currentTop20));
  });

  app.get("/json", (req, res) => {
    res.json(currentTop20);
  });

  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });

  app.listen(port, () => console.log(`🌍 Server running on port ${port}`));

  while (true) {
    try {
      await scan();
    } catch (err) {
      console.error("Scan error:", err.message);
    }
    await delay(config.REFRESH_INTERVAL || 60000); // Default 1 min
  }
}

start();
