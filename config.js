module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "your-telegram-bot-token",
  CHAT_ID: process.env.CHAT_ID || "your-default-chat-id", // group/channel ID
  ADMIN_ID: process.env.ADMIN_ID || "your-admin-user-id", // only this user gets admin confirmations
  CMC_API_KEY: process.env.CMC_API_KEY || "your-cmc-api-key",
  PORT: process.env.PORT || 10000,
  REFRESH_INTERVAL: 10 * 60 * 1000 // 10 mins for alert checking
};
