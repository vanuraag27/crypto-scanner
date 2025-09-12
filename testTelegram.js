const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  if (!config.BOT_TOKEN || !config.CHAT_ID) {
    console.error("❌ Missing BOT_TOKEN or CHAT_ID in env");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
      {
        chat_id: config.CHAT_ID,
        text: "✅ Telegram bot test successful",
      }
    );
    console.log("Message sent successfully!");
  } catch (err) {
    console.error("Telegram test error:", err.response?.data || err.message);
  }
}

testTelegram();
