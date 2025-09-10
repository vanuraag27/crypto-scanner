// config.js
module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  CMC_API_KEY: process.env.CMC_API_KEY || "",
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL)
    : 600000 // default 10 min
};
