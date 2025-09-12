const axios = require("axios");
const config = require("./config");

async function test() {
  try {
    const res = await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/getMe`);
    console.log("Bot info:", res.data);
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.ADMIN_ID,
      text: "✅ Test message from crypto-scanner (admin-only confirmation)"
    });
    console.log("Message sent to admin only.");
  } catch (err) {
    console.error("Telegram test error:", err.response?.data || err.message);
  }
}
test();
