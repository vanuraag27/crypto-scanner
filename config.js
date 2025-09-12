// config.js
// All secrets are pulled from environment variables (set in Render dashboard)

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,          // Telegram Bot Token
  CMC_API_KEY: process.env.CMC_API_KEY,      // CoinMarketCap API Key
  CHAT_ID: process.env.CHAT_ID,              // Telegram Chat ID
  ADMIN_ID: process.env.ADMIN_ID,            // Telegram Admin ID
  PORT: process.env.PORT || 10000,           // Server port
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com"
};
