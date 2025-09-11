const axios = require("axios");
const config = require("./config");

async function sendTestMessage() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ Missing TELEGRAM_TOKEN or CHAT_ID in config.");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from crypto-scanner bot!"
    });
    console.log("📩 Test message sent successfully.");
  } catch (err) {
    console.error("❌ Error sending test message:", err.response?.data || err.message);
  }
}

sendTestMessage();
