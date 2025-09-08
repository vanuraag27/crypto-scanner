require("dotenv").config();

module.exports = {
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL || 300000, // default 5 minutes
  USE_TELEGRAM: process.env.USE_TELEGRAM !== "false",       // default true unless explicitly set to "false"
  BOT_TOKEN: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
  CHAT_ID: process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  CMC_API_KEY: process.env.CMC_API_KEY
};
