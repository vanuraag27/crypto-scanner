// testTelegram.js
const { Telegraf } = require("telegraf");

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("TELEGRAM_TOKEN not set in env.");
  process.exit(1);
}
const bot = new Telegraf(token);
bot.telegram.getMe().then(info => {
  console.log("Bot info:", info);
  process.exit(0);
}).catch(err => {
  console.error("Telegram API error:", err.response ? err.response.data : err.message);
  process.exit(1);
});