// testTelegram.js
const { TELEGRAM_TOKEN, CHAT_ID } = require("./config");
const { Telegraf } = require("telegraf");

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_TOKEN or CHAT_ID in environment variables.");
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

(async () => {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      "✅ Test message from crypto-scanner bot. If you see this, Telegram integration works!"
    );
    console.log("Test message sent successfully.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to send test message:", err.response?.description || err.message);
    process.exit(1);
  }
})();
