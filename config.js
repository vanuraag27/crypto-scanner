require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN,
  CMC_API_KEY: process.env.CMC_API_KEY,
  PORT: process.env.PORT || 10000,
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL) || 600000,
  INVEST_AMOUNT: parseFloat(process.env.INVEST_AMOUNT) || 10000,
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true",
  ADMIN_ID: process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null
};
