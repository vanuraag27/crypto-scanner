module.exports = {
  PORT: process.env.PORT || 10000,
  BASE_URL: process.env.BASE_URL || "https://crypto-scanner-jaez.onrender.com",
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "your-telegram-bot-token",
  CHAT_ID: process.env.CHAT_ID || "your-chat-id",
  CMC_API_KEY: process.env.CMC_API_KEY || "your-cmc-api-key",
  ADMINS: [1783057190] // Replace with your Telegram user ID(s)
};
