require("dotenv").config();

module.exports = {
  // 🔑 API Keys
  CMC_API_KEY: process.env.CMC_API_KEY || "your_cmc_api_key_here",
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "your_telegram_token_here",

  // 📩 Telegram
  CHAT_ID: process.env.CHAT_ID || "",
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",

  // 💰 Investment settings
  INVEST_AMOUNT: parseInt(process.env.INVEST_AMOUNT) || 10000, // Default ₹10,000

  // ⚙️ Scanner settings
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL) || 10 * 60 * 1000, // 10 minutes
  PORT: process.env.PORT || 10000
};
