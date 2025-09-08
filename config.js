require("dotenv").config();

module.exports = {
  REFRESH_INTERVAL: 300000, // every 10 min (safe for free tier)
  USE_TELEGRAM: true,            // enable Telegram
  BOT_TOKEN: process.env.BOT_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  CMC_API_KEY: process.env.CMC_API_KEY // NEW
  };

