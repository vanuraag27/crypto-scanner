module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,   // Telegram Bot Token
  CHAT_ID: process.env.CHAT_ID,            // Your chat or group ID
  ADMIN_ID: process.env.ADMIN_ID,          // Admin Telegram ID
  CMC_API_KEY: process.env.CMC_API_KEY,    // CoinMarketCap API key
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",
  PORT: process.env.PORT || 10000,
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL, 10)
    : 600000 // default 10 minutes
};
