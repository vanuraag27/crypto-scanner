const express = require("express");
const axios = require("axios");
const config = require("./config");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

const app = express();
app.use(express.json());

// --- State ---
let baseline = {};
let alertedCoins = new Set();

// --- Helpers ---
function getISTDate() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function getLogFileName() {
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return path.join(__dirname, `alerts-${date}.log`);
}

async function sendMessage(chatId, text, markdown = false) {
  if (!config.USE_TELEGRAM || !config.BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

async function fetchTopCoins() {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit: 50, convert: "USD" }
    });
    return res.data.data || [];
  } catch (err) {
    console.error("❌ Error fetching CMC:", err.response?.data || err.message);
    return [];
  }
}

// --- Baseline ---
async function setBaseline() {
  const coins = await fetchTopCoins();
  if (!coins.length) return;

  const sorted = coins.sort((a, b) =>
    b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h
  );
  const top10 = sorted.slice(0, 10);

  baseline = {
    time: getISTDate(),
    coins: {}
  };

  top10.forEach(c => {
    baseline.coins[c.symbol] = {
      name: c.name,
      price: c.quote.USD.price,
      change24h: c.quote.USD.percent_change_24h
    };
  });

  fs.writeFileSync("baseline.json", JSON.stringify(baseline, null, 2));
  fs.writeFileSync(getLogFileName(), `🚀 Alerts Log for ${getISTDate()}\n\n`);

  let msg = `✅ *Baseline set (6 AM IST ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })})*\nMonitoring top 10:\n`;
  top10.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} - $${c.quote.USD.price.toFixed(2)} (24h: ${c.quote.USD.percent_change_24h.toFixed(2)}%)\n`;
  });

  alertedCoins.clear();
  await sendMessage(config.CHAT_ID, msg, true);
  console.log(msg);
}

// --- Alerts ---
async function checkAlerts() {
  if (!baseline || !baseline.coins) return;

  const coins = await fetchTopCoins();
  if (!coins.length) return;

  const logFile = getLogFileName();

  for (const coin of coins) {
    if (!baseline.coins[coin.symbol]) continue;

    const baselinePrice = baseline.coins[coin.symbol].price;
    const currentPrice = coin.quote.USD.price;
    const dropPercent = ((baselinePrice - currentPrice) / baselinePrice) * 100;

    if (dropPercent >= 10 && !alertedCoins.has(coin.symbol)) {
      const alert = `⚠️ ALERT: ${coin.symbol} dropped ${dropPercent.toFixed(2)}% since 6 AM baseline.\n💰 Current: $${currentPrice.toFixed(2)} | Baseline: $${baselinePrice.toFixed(2)}\n⏱️ ${getISTDate()}`;

      fs.appendFileSync(logFile, alert + "\n\n");
      await sendMessage(config.CHAT_ID, alert, false);

      alertedCoins.add(coin.symbol);
      console.log(alert);
    }
  }
}

// --- Daily Summary ---
async function sendDailySummary() {
  if (!baseline || !baseline.coins) return;

  const coins = await fetchTopCoins();
  if (!coins.length) return;

  let summary = `📊 *Daily Summary (10 PM IST ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })})*\nPerformance ranked best → worst:\n`;

  const performance = Object.values(baseline.coins).map(base => {
    const coin = coins.find(c => c.name === base.name || c.symbol === base.symbol);
    if (!coin) return null;
    const change = ((coin.quote.USD.price - base.price) / base.price) * 100;
    return {
      symbol: coin.symbol,
      price: coin.quote.USD.price,
      change
    };
  }).filter(Boolean);

  performance.sort((a, b) => b.change - a.change);

  performance.forEach((p, i) => {
    summary += `${i + 1}. ${p.symbol} - $${p.price.toFixed(2)} | Change: ${p.change.toFixed(2)}%\n`;
  });

  await sendMessage(config.CHAT_ID, summary, true);
  console.log(summary);
}

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! You’ll now receive updates.\n\nUse:\n`/status` → Check scanner\n`/top10` → Today’s baseline\n`/alerts` → Today’s alerts log\n/help → Commands", true);
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Scanner running.\n⏱️ Last baseline: ${baseline.time || "Not set yet"}`, false);
  } else if (text === "/top10") {
    if (!baseline || !baseline.coins) {
      await sendMessage(chatId, "❌ No baseline set yet.", false);
    } else {
      let msg = `📌 *Today’s Baseline (6 AM IST)*\n`;
      let i = 1;
      for (const [sym, data] of Object.entries(baseline.coins)) {
        msg += `${i++}. ${sym} - $${data.price.toFixed(2)} (24h: ${data.change24h.toFixed(2)}%)\n`;
      }
      await sendMessage(chatId, msg, true);
    }
  } else if (text === "/alerts") {
    try {
      const logFile = getLogFileName();
      if (fs.existsSync(logFile)) {
        const logs = fs.readFileSync(logFile, "utf8") || "No alerts yet today.";
        await sendMessage(chatId, `📜 *Today’s Alerts:*\n\n${logs}`, true);
      } else {
        await sendMessage(chatId, "📭 No alerts yet today.", false);
      }
    } catch (err) {
      await sendMessage(chatId, "❌ Error reading alerts log.", false);
    }
  } else if (text === "/help") {
    await sendMessage(chatId, "📖 *Commands:*\n/start - Start updates\n/status - Check scanner\n/top10 - Today’s baseline\n/alerts - Today’s alerts log\n/help - Show this help menu", true);
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Type /help to see commands.", false);
  }

  res.sendStatus(200);
});

// --- Scheduler ---
schedule.scheduleJob("0 6 * * *", { tz: "Asia/Kolkata" }, setBaseline);
schedule.scheduleJob("0 22 * * *", { tz: "Asia/Kolkata" }, sendDailySummary);
setInterval(checkAlerts, config.REFRESH_INTERVAL);

// --- Server ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  // Set webhook
  try {
    const webhookUrl = `${config.BASE_URL}/webhook`;
    await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    console.log(`✅ Webhook set: ${webhookUrl}`);
  } catch (err) {
    console.error("❌ Webhook setup error:", err.message);
  }
  console.log("🔍 Scanner initialized");
});
