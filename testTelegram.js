const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: "✅ Telegram bot test successful"
    });
    console.log("Message sent successfully!");
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
}

testTelegram();
