// cryptoScanner.js
const axios = require("axios");
const chalk = require("chalk");
const config = require("./config");

// --- State ---
let cachedHistory = new Map();
let predictedCoins = new Set();
let lastPredictionTime = 0;

// --- Delay helper ---
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Telegram ---
async function sendTelegram(message) {
  if (!config.USE_TELEGRAM) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: message
    });
  } catch (err) {
    console.error("Telegram error:", err.response ? err.response.data : err.message);
  }
}

// --- Fetch top 20 coins ---
async function fetchTopCoins() {
  try {
    const { data } = await axios.get("https://api.coingecko.com/api/v3/coins/markets", {
      params: {
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: 20,
        page: 1,
        price_change_percentage: "24h"
      }
    });
    return data;
  } catch (err) {
    console.error("Error fetching top coins:", err.response ? err.response.data : err.message);
    return [];
  }
}

// --- Fetch 7-day history with caching ---
async function fetch7DayHistory(coinId) {
  const now = Date.now();
  const cache = cachedHistory.get(coinId);
  if (cache && now - cache.timestamp < 30 * 60 * 1000) return cache.prices;

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
      { params: { vs_currency: "usd", days: 7 } }
    );
    await delay(1500);
    const prices = data.prices.map(p => p[1]);
    cachedHistory.set(coinId, { prices, timestamp: now });
    return prices;
  } catch (err) {
    console.error(`Error fetching 7-day history for ${coinId}:`, err.response ? err.response.data : err.message);
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
    const prices = await fetch7DayHistory(coin.id);
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

// --- Display dashboard ---
function displayDashboard(top20) {
  console.clear();
  console.log(chalk.bold.cyan("🚀 Crypto Scanner Dashboard"));
  console.log(chalk.gray(`⏱️ Updated: ${new Date().toLocaleTimeString()}\n`));

  console.log(chalk.bold.yellow("Predicted Top Movers (Next 24h):"));
  top20.filter(c => predictedCoins.has(c.id)).forEach(c => {
    const move = c.predictedMove !== undefined ? c.predictedMove.toFixed(2) : "N/A";
    console.log(chalk.magenta(`🔮 ${c.symbol.toUpperCase()} (${c.name}): ±${move}%`));
  });

  console.log("\n" + chalk.bold.blue("Top 20 Coins by 24h Change:"));
  top20.forEach(coin => {
    const change = coin.price_change_percentage_24h !== undefined ? coin.price_change_percentage_24h.toFixed(2) : "N/A";
    const price = coin.current_price !== undefined ? coin.current_price.toFixed(4) : "N/A";
    let line = `${coin.market_cap_rank}. ${coin.symbol.toUpperCase()} (${coin.name}) - ${change}% - $${price}`;
    if (coin.price_change_percentage_24h >= config.ALERT_10_PERCENT_THRESHOLD) line = chalk.green(line + " 🚀");
    if (coin.price_change_percentage_24h <= -config.ALERT_10_PERCENT_THRESHOLD) line = chalk.red(line + " 🔻");
    if (predictedCoins.has(coin.id)) line = chalk.magenta(line);
    console.log(line);
  });
}

// --- Main scan loop ---
async function scan() {
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  await predictTopCoins(coins);
  displayDashboard(coins);
}

// --- Start scanner ---
async function start() {
  while (true) {
    try {
      await scan();
    } catch (err) {
      console.error("Scan error:", err.message);
    }
    await delay(config.REFRESH_INTERVAL);
  }
}

start();
