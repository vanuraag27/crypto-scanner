require("dotenv").config();

module.exports = {
  REFRESH_INTERVAL: 60000,       // scan every 1 min
  ALERT_UP_THRESHOLD: 10,        // % gain alert
  ALERT_DOWN_THRESHOLD: -10,     // % drop alert
  USE_TELEGRAM: true,            // enable Telegram
  BOT_TOKEN: process.env.BOT_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  MIN_VOLUME: 500000,
  FAST_DELTA_THRESHOLD: 0.5,
  ALERT_10_PERCENT_THRESHOLD: 10,
  ALERT_20_PERCENT_THRESHOLD: 20,
  PREDICTION_TOP_N: 20
};

