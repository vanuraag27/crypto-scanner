const axios = require("axios");
const { BOT_TOKEN, CHAT_ID } = require("./config");

async function testTelegram() {
  try {
    // Send a test message
    const sendUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await axios.post(sendUrl, {
      chat_id: CHAT_ID,
      text: "✅ Telegram bot test successful"
    });

    console.log("✅ Message sent successfully!");
    console.log("Response:", res.data);

    // Also fetch updates to display your chat_id
    const updatesUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
    const updates = await axios.get(updatesUrl);

    if (updates.data.result.length > 0) {
      const chatId = updates.data.result[0].message.chat.id;
      console.log("👉 Your CHAT_ID is:", chatId);
    } else {
      console.log("⚠️ No updates found. Make sure you send /start to your bot in Telegram first.");
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

testTelegram();
