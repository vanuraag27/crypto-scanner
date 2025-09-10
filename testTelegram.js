// testTelegram.js
const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");

const BOT_TOKEN = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Telegram token or chat ID not configured.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

async function testTelegram() {
  try {
    await bot.sendMessage(CHAT_ID, "✅ Telegram bot test successful (from testTelegram.js)");
    console.log("📩 Message sent successfully!");
  } catch (err) {
    console.error("❌ Error sending message:", err.response?.body || err.message);
  }
}

testTelegram();
