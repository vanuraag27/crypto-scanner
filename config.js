require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  CMC_API_KEY: process.env.CMC_API_KEY || "",
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",
  REFRESH_INTERVAL: 5 * 60 * 1000 // check alerts every 5 minutes
};
