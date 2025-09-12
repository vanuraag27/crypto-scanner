// testTelegram.js
const fs = require("fs");
const axios = require("axios");
const config = require("./config");

async function getSavedChatId() {
  try {
    const file = "./chat.json";
    if (fs.existsSync(file)) {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      return v.chatId || null;
    }
  } catch (e) {
    console.error("read chat.json:", e.message);
  }
  return null;
}

async function test() {
  const chatFromEnv = process.env.CHAT_ID || null;
  const savedChat = await getSavedChatId();
  const chatId = savedChat || chatFromEnv;
  if (!chatId) {
    console.error("No chat id available. Send /start to the bot or set CHAT_ID env var.");
    return;
  }
  if (!config.BOT_TOKEN) {
    console.error("Missing TELEGRAM_TOKEN env var.");
    return;
  }

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text: "✅ testTelegram: bot is able to send messages to this chat."
      }
    );
    console.log("Message sent:", res.data.ok ? "OK" : res.data);
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
  }
}

test();
