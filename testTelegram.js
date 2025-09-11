const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ TELEGRAM_TOKEN or CHAT_ID not set");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from crypto-scanner"
    });
    console.log("📩 Telegram test message sent successfully");
  } catch (err) {
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

testTelegram();
