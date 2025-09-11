const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const config = require("./config");

const app = express();
app.use(express.json());

// --- Storage ---
let baselineData = { date: "", top10: [], baselinePrices: {}, profitHistory: {} };

function loadBaseline() {
  try {
    if (fs.existsSync(config.BASELINE_FILE)) {
      baselineData = JSON.parse(fs.readFileSync(config.BASELINE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error loading baseline:", err.message);
  }
}

function saveBaseline() {
  try {
    fs.writeFileSync(config.BASELINE_FILE, JSON.stringify(baselineData, null, 2));
  } catch (err) {
    console.error("Error saving baseline:", err.message);
  }
}

loadBaseline();

// --- Telegram Helper ---
async function sendMessage(chatId, text, markdown = false) {
  if (!config.USE_TELEGRAM) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
    });
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
  }
}

// --- Fetch Market Data ---
async function fetchMarket(limit = 50) {
  const res = await axios.get(
    "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
    {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
    }
  );
  return res.data.data.map((c) => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h,
    volume: c.quote.USD.volume_24h,
  }));
}

// --- Baseline at 6 AM IST ---
async function setBaseline() {
  try {
    const coins = await fetchMarket(50);
    const sorted = [...coins].sort((a, b) => b.change - a.change);
    const top10 = sorted.slice(0, 10);

    baselineData.date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    baselineData.top10 = top10;
    baselineData.baselinePrices = {};
    baselineData.profitHistory = {};

    top10.forEach((c) => {
      baselineData.baselinePrices[c.symbol] = c.price;
    });

    saveBaseline();

    let msg = `✅ *Baseline set (6 AM IST ${baselineData.date})*\nMonitoring top 10:\n`;
    top10.forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });

    await sendMessage(config.CHAT_ID, msg, true);
  } catch (err) {
    console.error("Baseline error:", err.message);
  }
}

// --- Alert Monitoring ---
async function monitorAlerts() {
  if (!baselineData.top10.length) return;
  try {
    const coins = await fetchMarket(50);
    const map = {};
    coins.forEach((c) => (map[c.symbol] = c));

    for (let symbol of Object.keys(baselineData.baselinePrices)) {
      const baselinePrice = baselineData.baselinePrices[symbol];
      const nowPrice = map[symbol]?.price;
      if (!baselinePrice || !nowPrice) continue;

      const dropPct = ((nowPrice - baselinePrice) / baselinePrice) * 100;
      if (dropPct <= -10) {
        await sendMessage(
          config.CHAT_ID,
          `🚨 ALERT: ${symbol} dropped ${dropPct.toFixed(2)}% from baseline\n📉 Current: $${nowPrice.toFixed(
            2
          )}\n⏱️ ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`
        );
      }
    }
  } catch (err) {
    console.error("Monitor error:", err.message);
  }
}

// --- Daily Summary at 10 PM IST ---
async function sendSummary() {
  if (!baselineData.top10.length) return;
  try {
    const coins = await fetchMarket(50);
    const summary = baselineData.top10.map((b) => {
      const current = coins.find((c) => c.symbol === b.symbol);
      if (!current) return null;
      const baseline = baselineData.baselinePrices[b.symbol];
      const profit = ((current.price - baseline) / baseline) * 100;
      return { ...current, profit };
    }).filter(Boolean);

    summary.sort((a, b) => b.profit - a.profit);

    let msg = `📊 *Daily Summary (10 PM IST ${baselineData.date})*\nRanked best → worst:\n`;
    summary.forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} | Profit: ${c.profit.toFixed(2)}%\n`;
    });

    await sendMessage(config.CHAT_ID, msg, true);
  } catch (err) {
    console.error("Summary error:", err.message);
  }
}

// --- Scheduler ---
cron.schedule("30 0 * * *", setBaseline, { timezone: "Asia/Kolkata" }); // 6 AM IST
cron.schedule("30 16 * * *", sendSummary, { timezone: "Asia/Kolkata" }); // 10 PM IST
setInterval(monitorAlerts, config.REFRESH_INTERVAL);

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(
      chatId,
      "👋 Welcome! Commands:\n/status\n/help\n/top10\n/profit\n/clearhistory (admin only)"
    );
  } else if (text === "/status") {
    await sendMessage(chatId, "✅ Scanner is running fine.");
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 *Commands:*\n/start\n/status\n/top10\n/profit\n/clearhistory (admin only)",
      true
    );
  } else if (text === "/top10") {
    if (!baselineData.top10.length) {
      await sendMessage(chatId, "❌ Baseline not set yet.");
    } else {
      let out = `📌 *Today's Top 10 (Baseline ${baselineData.date})*\n`;
      baselineData.top10.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
      });
      await sendMessage(chatId, out, true);
    }
  } else if (text === "/profit") {
    if (!baselineData.top10.length) {
      await sendMessage(chatId, "❌ Baseline not set yet.");
    } else {
      const coins = await fetchMarket(50);
      let summary = baselineData.top10.map((b) => {
        const current = coins.find((c) => c.symbol === b.symbol);
        if (!current) return null;
        const baseline = baselineData.baselinePrices[b.symbol];
        const profit = ((current.price - baseline) / baseline) * 100;
        return { ...current, profit };
      }).filter(Boolean);

      summary.sort((a, b) => b.profit - a.profit);

      let out = `💰 *Profit since 6 AM IST (${baselineData.date})*\n`;
      summary.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} | Profit: ${c.profit.toFixed(2)}%\n`;
      });
      await sendMessage(chatId, out, true);
    }
  } else if (text === "/clearhistory") {
    if (chatId.toString() === config.CHAT_ID.toString()) {
      baselineData.profitHistory = {};
      saveBaseline();
      await sendMessage(chatId, "🗑️ History cleared (admin-only).");
    } else {
      await sendMessage(chatId, "⛔ You don’t have permission for this command.");
    }
  }

  res.sendStatus(200);
});

// --- Start Server ---
app.listen(config.PORT, () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
});
