require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",

  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",

  CMC_API_KEY: process.env.CMC_API_KEY || "",
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL, 10)
    : 10 * 60 * 1000, // default 10 min

  INR_RATE: 83.0 // USD → INR conversion
};
