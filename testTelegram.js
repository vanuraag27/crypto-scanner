const axios = require("axios");
const { BOT_TOKEN, CHAT_ID } = require("./config");

async function testTelegram() {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: "✅ Telegram bot test successful"
    });
    console.log("Message sent successfully!");
  } catch (err) {
    console.error("Error sending message:", err.response?.data || err.message);
  }
}

testTelegram();
