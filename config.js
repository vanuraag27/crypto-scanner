// config.js
require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  ADMIN_ID: process.env.ADMIN_ID,
  CMC_API_KEY: process.env.CMC_API_KEY,
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || "600000", 10), // 10 min default
  BASELINE_HOUR: process.env.BASELINE_HOUR || "6", // 6 AM IST by default
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.RENDER_EXTERNAL_URL || "https://crypto-scanner-jaez.onrender.com"
};
