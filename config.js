require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_TOKEN || "",
  CHAT_ID: process.env.CHAT_ID || "",
  CMC_API_KEY: process.env.CMC_API_KEY || "",
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || "600000", 10), // 10 min default
  USE_TELEGRAM: process.env.USE_TELEGRAM === "true"
};
