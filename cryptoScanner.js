// cryptoScanner.js
const axios = require("axios");
const chalk = require("chalk");
const config = require("./config");

// Telegram config
const TELEGRAM_API = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

// Refresh interval (10 minutes = 600000 ms to avoid 429 errors)
const REFRESH_INTERVAL = 600000;

// Simple in-memory cache
let lastData = null;
let lastUpdated = null;

// Fetch top coins (cached)
async function fetchTopCoins() {
  try {
    // If cached data is less than 10 min old, reuse it
    if (lastData && Date.now() - lastUpdated < REFRESH_INTERVAL) {
      return lastData;
    }

    const url =
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h";
    const response = await axios.get(url);

    lastData = response.data;
    lastUpdated = Date.now();

    return lastData;
  } catch (error) {
    console.error(
      chalk.red("Error fetching top coins:"),
      error.response?.data || error.message
    );
    return [];
  }
}

// Send message to Telegram
async function sendToTelegram(message) {
  try {
    await axios.post(TELEGRAM_API, {
      chat_id: config.telegramChatId,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
  }
}

// Main scanner
async function runScanner() {
  console.clear();
  console.log(chalk.cyan("🚀 Crypto Scanner Dashboard"));

  const coins = await fetchTopCoins();
  if (!coins || coins.length === 0) {
    console.log(chalk.red("No coins data available."));
    return;
  }

  console.log(chalk.yellow(`⏱️ Updated: ${new Date().toLocaleTimeString()}\n`));

  console.log(chalk.green("Top 20 by Market Cap (Cached if API limited):"));
  coins.forEach((coin, idx) => {
    console.log(
      `${idx + 1}. ${chalk.bold(coin.symbol.toUpperCase())} (${coin.name}) - ${chalk.cyan(
        (coin.price_change_percentage_24h || 0).toFixed(2) + "%"
      )} - $${coin.current_price.toFixed(4)}`
    );
  });

  // Telegram alert
  let message = "📊 *Top 20 Coins (Market Cap)*\n\n";
  coins.forEach((coin, idx) => {
    message += `${idx + 1}. ${coin.symbol.toUpperCase()} - ${coin.price_change_percentage_24h?.toFixed(
      2
    )}% - $${coin.current_price.toFixed(4)}\n`;
  });
  message += `\n⏱️ Updated: ${new Date().toLocaleTimeString()}`;

  await sendToTelegram(message);
}

// Run on interval
runScanner();
setInterval(runScanner, REFRESH_INTERVAL);
