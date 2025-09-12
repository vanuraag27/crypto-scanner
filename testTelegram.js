const axios = require("axios");
const config = require("./config");

async function testMessage() {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.CHAT_ID,
      text: "🔔 Test message from testTelegram.js"
    });
    console.log("✅ Test sent:", res.data);
  } catch (err) {
    console.error("❌ Test failed:", err.response?.data || err.message);
  }
}

testMessage();
