// config.js
require("dotenv").config();

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  ADMIN_ID: process.env.ADMIN_ID,
  CMC_API_KEY: process.env.CMC_API_KEY,
  INVEST_AMOUNT: process.env.INVEST_AMOUNT || 10000,
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL || 60000,

  // Baseline schedule (IST)
  BASELINE_HOUR: parseInt(process.env.BASELINE_HOUR || "6", 10),   // default 6 AM IST
  BASELINE_MINUTE: parseInt(process.env.BASELINE_MINUTE || "0", 10) // default 00 minutes
};
