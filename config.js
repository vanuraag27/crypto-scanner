require("dotenv").config();

module.exports = {
  REFRESH_INTERVAL: 10 * 60 * 1000, // every 10 min (safe for free tier)
  ALERT_UP_THRESHOLD: 10,        // % gain alert
  ALERT_DOWN_THRESHOLD: -10,     // % drop alert
  USE_TELEGRAM: true,            // enable Telegram
  BOT_TOKEN: process.env.BOT_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  CMC_API_KEY: process.env.CMC_API_KEY // NEW
  MIN_VOLUME: 500000,
  FAST_DELTA_THRESHOLD: 0.5,
  ALERT_10_PERCENT_THRESHOLD: 10,
  ALERT_20_PERCENT_THRESHOLD: 20,
  PREDICTION_TOP_N: 20
};

