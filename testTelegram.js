const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ BOT_TOKEN or CHAT_ID missing");
    return;
  }

  try {
    const res = await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Test message from Crypto Scanner bot",
      parse_mode: "Markdown"
    });

    if (res.data.ok) {
      console.log("📩 Test message sent successfully");
    } else {
      console.error("❌ Failed to send test:", res.data);
    }
  } catch (err) {
    console.error("❌ Telegram test error:", err.response?.data || err.message);
  }
}

testTelegram();
