// config.js - read from environment (Render)
require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  CMC_API_KEY: process.env.CMC_API_KEY,
  ADMIN_ID: process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null,
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 10000,
  BASE_URL: process.env.BASE_URL || null,
  USE_TELEGRAM: (process.env.USE_TELEGRAM || "true") === "true",
  // in ms; default 60s
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL, 10)
    : 60 * 1000,
  // how many top coins to fetch
  FETCH_LIMIT: process.env.FETCH_LIMIT ? parseInt(process.env.FETCH_LIMIT, 10) : 50,
  // alert threshold (negative percent). Example -10 = alert on -10% or worse
  ALERT_DROP_PERCENT: process.env.ALERT_DROP_PERCENT
    ? parseFloat(process.env.ALERT_DROP_PERCENT)
    : -10,
  // baseline hour in IST (0-23). Default 6. Set to 10 to test.
  BASELINE_HOUR: process.env.BASELINE_HOUR
    ? parseInt(process.env.BASELINE_HOUR, 10)
    : 6
};
