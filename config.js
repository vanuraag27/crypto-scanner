module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  CMC_API_KEY: process.env.CMC_API_KEY,
  CHAT_ID: process.env.CHAT_ID,
  ADMIN_ID: process.env.ADMIN_ID,
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  INVEST_AMOUNT: parseFloat(process.env.INVEST_AMOUNT || "10000"),
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || "60000"),
  PORT: process.env.PORT || 10000,
  BASELINE_HOUR: parseInt(process.env.BASELINE_HOUR || "6"), // IST hour (0-23)
};
