const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

bot.on("message", (msg) => {
  console.log("Received:", msg.text);
  bot.sendMessage(msg.chat.id, "✅ Test message received successfully!");
});
