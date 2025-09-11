const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ BOT_TOKEN or CHAT_ID not set in config.js/env");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from crypto scanner bot."
    });
    console.log("📩 Test message sent successfully!");
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

testTelegram();
