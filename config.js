// config.js
module.exports = {
  REFRESH_INTERVAL: 60000,       // scan every 1 minute
  ALERT_UP_THRESHOLD: 10,        // % gain to alert
  ALERT_DOWN_THRESHOLD: -10,     // % drop to alert
  USE_TELEGRAM: true,            // enable Telegram alerts
  BOT_TOKEN=8021807728:AAEfBJTy_znD0YarO8Mm7O_YdHDEnZx7q-M
  CHAT_ID=1783057190
  REFRESH_INTERVAL: 30 * 1000, // 30 seconds
  MIN_VOLUME: 500000, // Only scan coins with volume > $500k
  FAST_DELTA_THRESHOLD: 0.5, // Only alert if coin moves more than $0.5 since last scan
  ALERT_10_PERCENT_THRESHOLD: 10, // Only alert if 24h change ≥ 10%
  ALERT_20_PERCENT_THRESHOLD: 20,  // Only alert if 24h change ≥ 20%
  PREDICTION_TOP_N: 20 // Number of coins to show predicted gain/loss
};

