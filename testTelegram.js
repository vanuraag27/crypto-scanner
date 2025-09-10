const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  const token = config.BOT_TOKEN;
  const chatId = config.CHAT_ID;

  if (!token || !chatId) {
    console.error("❌ Missing TELEGRAM_TOKEN or CHAT_ID");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: "✅ Test message: Telegram bot is working!"
    });
    console.log("📩 Test message sent successfully!");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

testTelegram();
