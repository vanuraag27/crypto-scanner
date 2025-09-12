const express = require("express");
const axios = require("axios");
const config = require("./config");

const app = express();
app.use(express.json());

let botUrl = `https://api.telegram.org/bot${config.BOT_TOKEN}`;

// Helper: send message
async function sendMessage(chatId, text, markdown = false) {
  try {
    await axios.post(`${botUrl}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

// Handle Webhook
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  if (text.startsWith("/setadmin")) {
    if (userId !== config.ADMIN_ID) {
      await sendMessage(chatId, "❌ Not authorized. Only current admin can set new admin.");
    } else {
      const parts = text.split(" ");
      if (parts.length === 2) {
        const newAdminId = parts[1].trim();
        config.ADMIN_ID = newAdminId;
        await sendMessage(chatId, `✅ Admin updated successfully to ${newAdminId}`);
        console.log(`🔐 Admin changed to ${newAdminId}`);
      } else {
        await sendMessage(chatId, "⚠️ Usage: /setadmin <telegram_id>");
      }
    }
  } else if (text === "/whoami") {
    await sendMessage(chatId, `👤 Your Telegram ID: ${userId}\nCurrent Admin ID: ${config.ADMIN_ID}`);
  } else {
    await sendMessage(chatId, "🤖 Bot is running. Use /whoami to check your ID.");
  }

  res.sendStatus(200);
});

// Start server
app.listen(config.PORT, () => {
  console.log(`🌍 Admin control server running on port ${config.PORT}`);
});
