const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  const token = config.BOT_TOKEN;
  const chatId = config.CHAT_ID;

  if (!token || !chatId) {
    console.error("❌ Telegram token or chat ID missing.");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: "✅ Telegram bot test successful"
    });
    console.log("📩 Test message sent successfully!");
  } catch (err) {
    console.error("❌ Error sending test message:", err.response?.data || err.message);
  }
}

testTelegram();
