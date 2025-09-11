module.exports = {
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",

  CMC_API_KEY: process.env.CMC_API_KEY || "",
  CHAT_ID: process.env.CHAT_ID || "",

  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || "600000"),

  ADMIN_ID: process.env.ADMIN_ID || "", // <-- Add your Telegram user ID here
};
