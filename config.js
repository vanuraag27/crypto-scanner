require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  ADMIN_ID: process.env.ADMIN_ID || "",

  CMC_API_KEY: process.env.CMC_API_KEY || "",
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",

  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || "300000") // 5 min
};
