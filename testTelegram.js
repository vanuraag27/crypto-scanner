const axios = require("axios");
const config = require("./config");

async function testTelegram() {
  const token = process.env.TELEGRAM_TOKEN || config.BOT_TOKEN;
  const chatId = process.env.CHAT_ID || config.CHAT_ID;

  if (!token || !chatId) {
    console.error("Telegram token or chat ID not configured.");
    return;
  }

  // Example profit calculation
  const invest = config.INVEST_AMOUNT;
  const fakeGain = (Math.random() * 0.1 + 0.02).toFixed(2); // 2%–12% random gain
  const profit = ((invest * fakeGain) / 100).toFixed(2);

  const message = `
✅ Telegram Bot Test Successful

💰 Investment Amount: ₹${invest.toLocaleString()}
📈 Predicted Gain: ${fakeGain}%
📊 Estimated Profit: ₹${profit}
  `;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    });
    console.log("Message sent successfully!");
  } catch (err) {
    console.error(
      "Error sending message:",
      err.response ? err.response.data : err.message
    );
  }
}

testTelegram();
