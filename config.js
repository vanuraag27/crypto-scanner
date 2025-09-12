module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "your_bot_token",
  CHAT_ID: process.env.CHAT_ID || "your_chat_id",
  CMC_API_KEY: process.env.CMC_API_KEY || "your_cmc_api_key",
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",
  PORT: process.env.PORT || 10000,
  REFRESH_INTERVAL: process.env.REFRESH_INTERVAL || 600000, // 10 min default
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true" || true,

  // 🔐 Admin ID → must be set to your Telegram user ID
  ADMIN_ID: process.env.ADMIN_ID || "123456789"
};
