const axios = require("axios");
const config = require("./config");

async function sendTestMessage() {
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
      {
        chat_id: config.CHAT_ID,
        text: `✅ Test message at ${new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata"
        })}`
      }
    );
    console.log("📩 Test message sent:", res.data);
  } catch (err) {
    console.error("❌ Failed to send test message:", err.response?.data || err.message);
  }
}

sendTestMessage();
