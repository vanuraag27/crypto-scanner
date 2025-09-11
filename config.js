module.exports = {
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",

  // Telegram
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "your_telegram_token_here",
  CHAT_ID: process.env.CHAT_ID || "your_admin_chat_id_here", // admin chat id
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true" || true,

  // CoinMarketCap API
  CMC_API_KEY: process.env.CMC_API_KEY || "your_cmc_api_key_here",

  // Scanner
  REFRESH_INTERVAL: 600000, // 10 minutes default

  // File-based storage
  BASELINE_FILE: "./baseline.json",
};
