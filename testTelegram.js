const axios = require("axios");

// Try both possible sources of configuration
try {
  var { BOT_TOKEN, CHAT_ID } = require("./config");
} catch (e) {
  console.log("⚠️ Could not load config.js, trying environment variables...");
  var BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  var CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;
}

async function testTelegram() {
  console.log("Testing Telegram configuration...");
  console.log("BOT_TOKEN:", BOT_TOKEN ? "SET" : "MISSING");
  console.log("CHAT_ID:", CHAT_ID ? "SET" : "MISSING");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("❌ Missing required environment variables");
    console.log("Please set BOT_TOKEN and CHAT_ID in your environment");
    return;
  }

  try {
    // First test if bot token is valid
    const botInfoUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`;
    const botInfo = await axios.get(botInfoUrl);
    console.log("✅ Bot token is valid");
    console.log("Bot name:", botInfo.data.result.first_name);
    console.log("Bot username:", botInfo.data.result.username);

    // Send a test message
    const sendUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await axios.post(sendUrl, {
      chat_id: CHAT_ID,
      text: "✅ Telegram bot test successful!\nThis is a test message from your crypto scanner."
    });

    console.log("✅ Message sent successfully!");
    console.log("Message ID:", res.data.result.message_id);

    // Also fetch updates to display your chat_id
    const updatesUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
    const updates = await axios.get(updatesUrl);

    if (updates.data.result.length > 0) {
      console.log("\n👉 Available chats:");
      updates.data.result.forEach((update, index) => {
        if (update.message) {
          console.log(`${index + 1}. Chat ID: ${update.message.chat.id} - ${update.message.chat.first_name || ''} ${update.message.chat.last_name || ''} (@${update.message.chat.username || 'no username'})`);
        }
      });
    } else {
      console.log("⚠️ No updates found. Make sure you've sent a message to your bot.");
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    
    if (err.response?.status === 404) {
      console.log("This usually means:");
      console.log("1. Your BOT_TOKEN is incorrect");
      console.log("2. Your bot hasn't been created with @BotFather");
    } else if (err.response?.status === 400) {
      console.log("This usually means your CHAT_ID is incorrect");
    } else if (err.code === 'ENOTFOUND') {
      console.log("Network error - check your internet connection");
    }
  }
}

testTelegram();
