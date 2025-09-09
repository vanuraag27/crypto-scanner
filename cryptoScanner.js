require('dotenv').config();
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
let userCurrency = "USD"; // Default currency
let userCountry = "Unknown"; // Default country

// --- Delay helper ---
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Telegram ---
async function sendTelegram(message) {
  if (!config.USE_TELEGRAM || !TELEGRAM_TOKEN || !CHAT_ID) {
    console.log("Skipping Telegram notification: not configured");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message
    });
    console.log("Telegram message sent successfully");
  } catch (err) {
    console.error("Telegram error:", err.response ? err.response.data : err.message);
  }
}

// --- Get user geolocation ---
async function getUserGeolocation(req) {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const { data } = await axios.get(`http://ip-api.com/json/${ip}`, { timeout: 5000 });
    return { country: data.country || "Unknown", currency: mapCountryToCurrency(data.countryCode) };
  } catch (err) {
    console.error("Geolocation error:", err.message);
    return { country: "Unknown", currency: "USD" };
  }
}

// --- Map country to currency ---
function mapCountryToCurrency(countryCode) {
  const currencyMap = {
    "IN": "INR",
    "US": "USD",
    "GB": "GBP",
    "EU": "EUR",
    "JP": "JPY",
    "NG": "NGN",
    "VN": "VND",
    "PH": "PHP",
    "TR": "TRY",
    "PE": "PEN"
  };
  return currencyMap[countryCode] || "USD";
}

// --- Fetch top 20 coins (CMC API) ---
async function fetchTopCoins() {
  if (!CMC_API_KEY) {
    console.error("CMC API key not set.");
    return [];
  }
  try {
    console.log("Fetching top 20 coins from CMC...");
    const { data } = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      params: {
        start: 1,
        limit: 20,
        convert: "USD"
      },
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      timeout: 10000
    });
    console.log("Fetched top 20 coins successfully");
    return data.data.map(coin => ({
      id: coin.slug,
      symbol: coin.symbol,
      name: coin.name,
      current_price_usd: coin.quote.USD.price,
      price_change_percentage_24h: coin.quote.USD.percent_change_24h,
      market_cap_rank: coin.cmc_rank
    }));
  } catch (err) {
    console.error("Error fetching top coins:", err.response ? err.response.data : err.message);
    return [];
  }
}

// --- CoinGecko symbol to ID mapping ---
const symbolToCoinGeckoId = {
  "USDT": "tether",
  "USDC": "usd-coin",
  "HYPE": "hyperliquid",
  "USDE": "usd-coin",
  "BTC": "bitcoin",
  "ETH": "ethereum",
  "XRP": "ripple",
  "BNB": "binancecoin",
  "SOL": "solana",
  "DOGE": "dogecoin",
  "TRX": "tron",
  "ADA": "cardano",
  "LINK": "chainlink",
  "SUI": "sui",
  "XLM": "stellar",
  "BCH": "bitcoin-cash",
  "AVAX": "avalanche-2",
  "HBAR": "hedera",
  "LEO": "leo-token",
  "LTC": "litecoin"
};

// --- Fetch local currency price (CoinGecko) ---
async function fetchLocalPrice(symbol, currency) {
  try {
    const coinId = symbolToCoinGeckoId[symbol.toUpperCase()] || symbol.toLowerCase();
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: coinId,
        vs_currencies: currency.toLowerCase()
      },
      timeout: 5000
    });
    await delay(15000); // 15s to avoid rate limit
    return data[coinId][currency.toLowerCase()];
  } catch (err) {
    console.error(`Error fetching local price for ${symbol} in ${currency}:`, err.response ? err.response.data : err.message);
    return null;
  }
}

// --- Fetch 7-day history with caching (CoinGecko API) ---
async function fetch7DayHistory(symbol) {
  const now = Date.now();
  const cache = cachedHistory.get(symbol);

  if (cache && now - cache.timestamp < 30 * 60 * 1000) {
    console.log(`Using cached history for ${symbol}`);
    return cache.prices;
  }

  try {
    console.log(`Fetching 7-day history for ${symbol} from CoinGecko...`);
    const coinId = symbolToCoinGeckoId[symbol.toUpperCase()] || symbol.toLowerCase();
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
      {
        params: { vs_currency: "usd", days: 7, interval: "daily" },
        timeout: 10000
      }
    );
    await delay(15000); // 15s delay to avoid rate limit (4 calls/min)
    const prices = data.prices.map(p => p[1]);
    cachedHistory.set(symbol, { prices, timestamp: now });
    console.log(`Fetched 7-day history for ${symbol} successfully`);
    return prices;
  } catch (err) {
    console.error(`Error fetching 7-day history for ${symbol}:`, err.response ? err.response.data : err.message);
    if (err.response && err.response.status === 429) {
      console.log(`Rate limit hit for ${symbol}, returning empty prices`);
    }
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
async function predictTopCoins(coins, localCurrency) {
  const now = Date.now();
  if (now - lastPredictionTime < 30 * 60 * 1000) {
    console.log("Skipping prediction: too soon");
    return;
  }

  console.log("Predicting top coins...");
  const predictions = [];
  for (const coin of coins) {
    const prices = await fetch7DayHistory(coin.symbol);
    const predictedMove = estimateNext24hMove(prices);
    const localPrice = await fetchLocalPrice(coin.symbol, localCurrency);
    predictions.push({ ...coin, predictedMove, localPrice });
  }

  predictions.sort((a, b) => b.predictedMove - a.predictedMove);
  const topPredicted = predictions.slice(0, config.PREDICTION_TOP_N);

  predictedCoins.clear();
  topPredicted.forEach(c => predictedCoins.add(c.id));

  const message = topPredicted
    .map(c => {
      const move = c.predictedMove !== undefined ? c.predictedMove.toFixed(2) : "N/A";
      const usdPrice = c.current_price_usd !== undefined ? c.current_price_usd.toFixed(2) : "N/A";
      const localPrice = c.localPrice !== null ? c.localPrice.toFixed(2) : "N/A";
      return `${c.symbol.toUpperCase()} (${c.name}): ±${move}% ($${usdPrice}, ${localCurrency} ${localPrice})`;
    })
    .join("\n");

  if (topPredicted.every(c => c.predictedMove === 0)) {
    console.log("No valid predictions due to API errors, skipping Telegram notification");
    return;
  }

  await sendTelegram(`🔮 Top ${config.PREDICTION_TOP_N} Coins Likely to Move Next 24h (${userCountry}):\n\n${message}`);
  lastPredictionTime = now;
  console.log("Prediction completed");
}

// --- Generate HTML dashboard ---
function generateHTMLDashboard(top20, localCurrency) {
  let html = `<h1>🚀 Crypto Scanner Dashboard (${userCountry})</h1>`;
  html += `<p>⏱️ Updated: ${new Date().toLocaleTimeString()}</p>`;

  html += `<h2>Predicted Top Movers (Next 24h):</h2><ul>`;
  if (predictedCoins.size === 0) {
    html += `<li>No predictions available due to API limitations</li>`;
  } else {
    top20.filter(c => predictedCoins.has(c.id)).forEach(c => {
      const move = c.predictedMove !== undefined ? c.predictedMove.toFixed(2) : "N/A";
      const usdPrice = c.current_price_usd !== undefined ? c.current_price_usd.toFixed(2) : "N/A";
      const localPrice = c.localPrice !== null ? c.localPrice.toFixed(2) : "N/A";
      html += `<li>🔮 ${c.symbol.toUpperCase()} (${c.name}): ±${move}% ($${usdPrice}, ${localCurrency} ${localPrice})</li>`;
    });
  }
  html += `</ul>`;

  html += `<h2>Top 20 Coins by 24h Change:</h2><ol>`;
  top20.forEach(coin => {
    const change = coin.price_change_percentage_24h !== undefined ? coin.price_change_percentage_24h.toFixed(2) : "N/A";
    const usdPrice = coin.current_price_usd !== undefined ? coin.current_price_usd.toFixed(2) : "N/A";
    const direction = parseFloat(change) > 0 ? '📈' : '📉';
    let line = `${coin.symbol.toUpperCase()} (${coin.name}) ${change}% ${direction} - $${usdPrice}`;
    if (coin.price_change_percentage_24h >= config.ALERT_10_PERCENT_THRESHOLD) line += " 🚀";
    if (coin.price_change_percentage_24h <= -config.ALERT_10_PERCENT_THRESHOLD) line += " 🔻";
    html += `<li>${line}</li>`;
  });
  html += `</ol>`;

  html += `<a href="/json">View as JSON</a> | <a href="/health">Health Check</a>`;
  return html;
}

// --- Main scan loop ---
async function scan(localCurrency) {
  console.log("Starting scan...");
  const coins = await fetchTopCoins();
  if (!coins.length) {
    console.log("No coins fetched, skipping scan");
    return;
  }

  await predictTopCoins(coins, localCurrency);
  currentTop20 = coins; // Update for web serving
  console.log("Scan completed");
}

// --- Start scanner and web server ---
async function start() {
  console.log("🚀 Running Crypto Scanner (CMC)...");
  console.log(`⚠️ Telegram notifications: ${TELEGRAM_TOKEN && CHAT_ID ? "ENABLED" : "DISABLED"}`);
  console.log(`⚠️ CMC API: ${CMC_API_KEY ? "CONFIGURED" : "NOT CONFIGURED"}`);

  const app = express();
  const port = process.env.PORT || 10000;

  app.get("/", async (req, res) => {
    const geo = await getUserGeolocation(req);
    userCountry = geo.country;
    userCurrency = geo.currency;
    await scan(userCurrency);
    res.send(generateHTMLDashboard(currentTop20, userCurrency));
  });

  app.get("/json", async (req, res) => {
    const geo = await getUserGeolocation(req);
    userCountry = geo.country;
    userCurrency = geo.currency;
    await scan(userCurrency);
    res.json(currentTop20);
  });

  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });

  app.listen(port, () => console.log(`🌍 Server running on port ${port}`));

  // Run scan in the background with default USD
  setInterval(async () => {
    try {
      await scan("USD");
    } catch (err) {
      console.error("Scan error:", err.message);
    }
  }, config.REFRESH_INTERVAL || 60000);
}

start();
