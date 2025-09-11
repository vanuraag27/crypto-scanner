const axios = require("axios");
const config = require("./config");

async function testMessage() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ Missing TELEGRAM_TOKEN or CHAT_ID in config");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from Crypto Scanner bot"
    });
    console.log("📩 Test message sent successfully");
  } catch (err) {
    console.error("❌ Telegram test error:", err.response?.data || err.message);
  }
}

testMessage();
