// config.js
module.exports = {
  REFRESH_INTERVAL: 30 * 1000, // 30 seconds
  ALERT_UP_THRESHOLD: 10,        // % gain to alert
  ALERT_DOWN_THRESHOLD: -10,     // % drop to alert
  USE_TELEGRAM: true,            // enable Telegram alerts
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || '', // Use env var
  CHAT_ID: process.env.CHAT_ID || '',         // Use env var
  MIN_VOLUME: 500000, // Only scan coins with volume > $500k
  FAST_DELTA_THRESHOLD: 0.5, // Only alert if coin moves more than $0.5 since last scan
  ALERT_10_PERCENT_THRESHOLD: 10, // Only alert if 24h change ≥ 10%
  ALERT_20_PERCENT_THRESHOLD: 20,  // Only alert if 24h change ≥ 20%
  PREDICTION_TOP_N: 5 // Reduced to avoid CoinGecko rate limits
};
