// testTelegram.js
// Simple test script to verify Telegram bot messaging

const axios = require("axios");
const config = require("./config");

async function sendTestMessage() {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from testTelegram.js"
    });
    console.log("Message sent:", res.data);
  } catch (err) {
    console.error("Error sending test message:", err.response?.data || err.message);
  }
}

sendTestMessage();
