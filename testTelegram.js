```javascript
require('dotenv').config();
const axios = require('axios');
const config = require('./config');

// Prioritize environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || config.CHAT_ID;

async function testTelegram() {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.log("Skipping Telegram test: TELEGRAM_TOKEN or CHAT_ID not configured");
    return;
  }

  const message = "Test message from crypto-scanner Telegram bot";
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message
    });
    console.log("Test Telegram message sent successfully");
  } catch (err) {
    console.error("Telegram test error:", err.response ? err.response.data : err.message);
  }
}

testTelegram();
```
