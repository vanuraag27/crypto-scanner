const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  const token = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
  const chatId = process.env.CHAT_ID || config.CHAT_ID;

  if (!token || !chatId) {
    console.error("Telegram token or chat ID not configured.");
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: "✅ Telegram bot test successful"
    });
    console.log("Message sent successfully!");
  } catch (err) {
    console.error("Error sending message:", err.response ? err.response.data : err.message);
  }
}

testTelegram();
