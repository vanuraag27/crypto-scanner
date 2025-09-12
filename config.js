// config.js - read-only: uses environment variables (Render)
module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,        // required for Telegram
  CMC_API_KEY: process.env.CMC_API_KEY,         // required for CoinMarketCap
  ADMIN_ID: process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null, // admin Telegram id (string)
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || null,       // your public URL (https://your-app.onrender.com)
  USE_TELEGRAM: (process.env.USE_TELEGRAM || "true") === "true",
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL, 10)
    : 60 * 1000,                                // default 60s
  // coin selection: how many top coins to fetch for monitoring (50 is safe)
  FETCH_LIMIT: process.env.FETCH_LIMIT ? parseInt(process.env.FETCH_LIMIT, 10) : 50,
  // drop threshold for alerts (negative percent)
  ALERT_DROP_PERCENT: process.env.ALERT_DROP_PERCENT ? parseFloat(process.env.ALERT_DROP_PERCENT) : -10
};
