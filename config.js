module.exports = {
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",

  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",

  CMC_API_KEY: process.env.CMC_API_KEY || "",
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",

  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL
    ? parseInt(process.env.REFRESH_INTERVAL, 10)
    : 600000, // default 10 mins

  ADMIN_ID: process.env.ADMIN_ID || "" // <-- NEW: Only this Telegram user can run admin commands
};
