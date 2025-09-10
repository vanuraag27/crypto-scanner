const express = require("express");
const axios = require("axios");
const config = require("./config");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

const app = express();
app.use(express.json());

const baselinePath = path.join(__dirname, "baseline.json");
let baseline = loadBaseline();
let alertedCoins = new Set();

// --- Load baseline from file ---
function loadBaseline() {
  if (fs.existsSync(baselinePath)) {
    try {
      return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    } catch {
      return { date: null, coins: {} };
    }
  }
  return { date: null, coins: {} };
}

// --- Save baseline to file ---
function saveBaseline() {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
}

// --- Telegram helper ---
async function sendMessage(chatId, text, markdown = false) {
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

// --- Auto Webhook Setup ---
async function setWebhook() {
  if (!config.BOT_TOKEN) return;
  const webhookUrl = `${config.BASE_URL}/webhook`;

  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    if (res.data.ok) {
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } else {
      console.error("❌ Failed to set webhook:", res.data);
    }
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
}

// --- Handle Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(
      chatId,
      "👋 Welcome! You will now receive crypto scanner updates here.\n\nUse:\n`/status` → Check scanner\n`/top10` → Show today’s baseline\n`/help` → Commands",
      true
    );
  } else if (text === "/status") {
    await sendMessage(
      chatId,
      `✅ Scanner is running.\n📊 Baseline set: ${baseline.date || "Not yet"}\nMonitored coins: ${Object.keys(baseline.coins).length}`,
      false
    );
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 *Commands:*\n/start - Start updates\n/status - Scanner status\n/top10 - Show today’s baseline top 10\n/help - This menu",
      true
    );
  } else if (text === "/top10") {
    if (!baseline.date) {
      await sendMessage(chatId, "⚠️ No baseline set yet. Wait for 6 AM IST.", false);
    } else {
      let msg = `*📊 Top 10 Baseline (6 AM IST ${baseline.date})*\n`;
      Object.entries(baseline.coins).forEach(([sym, data], i) => {
        msg += `${i + 1}. ${sym} - $${data.price.toFixed(2)} (24h: ${data.change.toFixed(2)}%)\n`;
      });
      await sendMessage(chatId, msg, true);
    }
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Use `/help`.", false);
  }

  res.sendStatus(200);
});

// --- Fetch market data ---
async function fetchTopCoins(limit = 20) {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit, convert: "USD" }
  });
  return res.data.data;
}

// --- Set daily baseline at 6 AM IST ---
schedule.scheduleJob("0 6 * * *", { tz: "Asia/Kolkata" }, async () => {
  console.log("⏰ Setting baseline (6 AM IST)...");
  try {
    const coins = await fetchTopCoins(50);

    // rank by % gainers (last 24h)
    const sorted = coins
      .sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h)
      .slice(0, 10);

    baseline.date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    baseline.coins = {};
    sorted.forEach((coin) => {
      baseline.coins[coin.symbol] = {
        price: coin.quote.USD.price,
        change: coin.quote.USD.percent_change_24h
      };
    });

    saveBaseline();
    alertedCoins.clear();

    let msg = `*✅ Baseline set (6 AM IST ${baseline.date})*\nMonitoring top 10:\n`;
    sorted.forEach((coin, i) => {
      msg += `${i + 1}. ${coin.symbol} - $${coin.quote.USD.price.toFixed(2)} (24h: ${coin.quote.USD.percent_change_24h.toFixed(2)}%)\n`;
    });

    if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, msg, true);
    console.log("📊 Baseline saved & sent");
  } catch (err) {
    console.error("❌ Error setting baseline:", err.response?.data || err.message);
  }
});

// --- Monitor coins ---
async function monitorCoins() {
  if (!baseline.date) {
    console.log("⚠️ No baseline yet, skipping monitor.");
    return;
  }
  try {
    const symbols = Object.keys(baseline.coins);
    const coins = await fetchTopCoins(50);
    const map = {};
    coins.forEach((c) => (map[c.symbol] = c));

    for (const sym of symbols) {
      const base = baseline.coins[sym];
      const now = map[sym];
      if (!now) continue;

      const dropPct = ((now.quote.USD.price - base.price) / base.price) * 100;
      if (dropPct <= -10 && !alertedCoins.has(sym)) {
        alertedCoins.add(sym);
        const msg = `🚨 *ALERT: ${sym} dropped*\nBaseline: $${base.price.toFixed(2)}\nNow: $${now.quote.USD.price.toFixed(2)}\nChange: ${dropPct.toFixed(2)}%\nTime: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`;
        if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, msg, true);
        console.log(msg);
      }
    }
  } catch (err) {
    console.error("❌ Error monitoring coins:", err.response?.data || err.message);
  }
  setTimeout(monitorCoins, config.REFRESH_INTERVAL);
}

// --- Start server ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();
  monitorCoins();
});
