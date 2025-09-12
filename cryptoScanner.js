const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const config = require("./config");

const app = express();
app.use(express.json());

const baselineFile = path.join(__dirname, "baseline.json");

// --- Utility: Load/Save baseline ---
function loadBaseline() {
  try {
    if (fs.existsSync(baselineFile)) {
      return JSON.parse(fs.readFileSync(baselineFile));
    }
  } catch (err) {
    console.error("Error loading baseline:", err.message);
  }
  return null;
}
function saveBaseline(data) {
  try {
    fs.writeFileSync(baselineFile, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error saving baseline:", err.message);
  }
}

// --- Telegram helper ---
async function sendTelegram(chatId, text, markdown = false) {
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
    });
  } catch (err) {
    console.error("Telegram send error:", err.response?.data || err.message);
  }
}

// --- Fetch CMC data ---
async function fetchTopCoins(limit = 20) {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit, convert: "USD" },
  });
  return res.data.data;
}

// --- Baseline + alerts state ---
let baseline = loadBaseline();
let alertedCoins = new Set();

// --- Create new baseline ---
async function createBaseline(broadcast = true, adminReply = false) {
  try {
    const coins = await fetchTopCoins(50);
    const top10 = coins
      .sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h)
      .slice(0, 10)
      .map(c => ({
        symbol: c.symbol,
        price: c.quote.USD.price,
        change: c.quote.USD.percent_change_24h,
      }));

    baseline = {
      time: new Date().toISOString(),
      coins: top10,
    };
    saveBaseline(baseline);
    alertedCoins.clear();

    if (broadcast && config.CHAT_ID) {
      let out = `✅ *Baseline set (${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})*\nMonitoring top 10:\n`;
      top10.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
      });
      await sendTelegram(config.CHAT_ID, out, true);
    }

    if (adminReply) {
      await sendTelegram(config.ADMIN_ID, "✅ Baseline created manually.", false);
    }

    console.log("✅ Baseline set and saved");
  } catch (err) {
    console.error("Error creating baseline:", err.message);
  }
}

// --- Daily summary ---
async function sendDailySummary() {
  if (!baseline) return;
  try {
    const coins = await fetchTopCoins(50);
    const map = Object.fromEntries(coins.map(c => [c.symbol, c]));

    let perf = baseline.coins.map(b => {
      const now = map[b.symbol];
      if (!now) return null;
      const priceNow = now.quote.USD.price;
      const pct = ((priceNow - b.price) / b.price) * 100;
      return { symbol: b.symbol, priceNow, baseline: b.price, pct };
    }).filter(Boolean);

    perf.sort((a, b) => b.pct - a.pct);

    let out = `📊 *Daily Summary (10 PM IST ${new Date().toLocaleDateString("en-IN")})*\nPerformance ranked best → worst:\n`;
    perf.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} | Δ ${c.pct.toFixed(2)}% | $${c.baseline.toFixed(2)} → $${c.priceNow.toFixed(2)}\n`;
    });
    await sendTelegram(config.CHAT_ID, out, true);
  } catch (err) {
    console.error("Error daily summary:", err.message);
  }
}

// --- Alerts ---
async function checkAlerts() {
  if (!baseline) return;
  try {
    const coins = await fetchTopCoins(50);
    const map = Object.fromEntries(coins.map(c => [c.symbol, c]));

    for (let b of baseline.coins) {
      const now = map[b.symbol];
      if (!now) continue;
      const priceNow = now.quote.USD.price;
      const drop = ((priceNow - b.price) / b.price) * 100;

      if (drop <= -10 && !alertedCoins.has(b.symbol)) {
        let msg = `🚨 *ALERT*\n${b.symbol} dropped ${drop.toFixed(2)}%\nBaseline: $${b.price.toFixed(2)}\nNow: $${priceNow.toFixed(2)}\n⏱️ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
        await sendTelegram(config.CHAT_ID, msg, true);
        alertedCoins.add(b.symbol);
      }
    }
  } catch (err) {
    console.error("Error alerts:", err.message);
  }
}

// --- Telegram webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const isAdmin = chatId.toString() === config.ADMIN_ID.toString();

  if (text === "/start") {
    await sendTelegram(chatId, "👋 Welcome!\nUse:\n/status → Scanner status\n/top10 → Today’s baseline\n/profit → Gains since baseline\n/alerts → Active alerts\n/help → Commands", false);
  } else if (text === "/status") {
    await sendTelegram(chatId, `✅ Scanner running.\nBaseline: ${baseline ? new Date(baseline.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Not set"}`, false);
  } else if (text === "/top10") {
    if (!baseline) return await sendTelegram(chatId, "⚠️ Baseline not set yet.", false);
    let out = `Top 10 Baseline (${new Date(baseline.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });
    await sendTelegram(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline) return await sendTelegram(chatId, "⚠️ Baseline not set yet.", false);
    const coins = await fetchTopCoins(50);
    const map = Object.fromEntries(coins.map(c => [c.symbol, c]));
    let perf = baseline.coins.map(b => {
      const now = map[b.symbol];
      if (!now) return null;
      const priceNow = now.quote.USD.price;
      const pct = ((priceNow - b.price) / b.price) * 100;
      return { symbol: b.symbol, priceNow, baseline: b.price, pct };
    }).filter(Boolean);
    perf.sort((a, b) => b.pct - a.pct);
    let out = `Profit since ${new Date(baseline.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n`;
    perf.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} | Δ ${c.pct.toFixed(2)}% | $${c.baseline.toFixed(2)} → $${c.priceNow.toFixed(2)}\n`;
    });
    await sendTelegram(chatId, out, true);
  } else if (text === "/alerts") {
    await sendTelegram(chatId, `🚨 Alerts fired: ${[...alertedCoins].join(", ") || "None"}`, false);
  } else if (text === "/clearhistory") {
    if (!isAdmin) return await sendTelegram(chatId, "⛔ Not authorized", false);
    alertedCoins.clear();
    await sendTelegram(config.ADMIN_ID, "✅ Alert history cleared.", false);
  } else if (text === "/setbaseline") {
    if (!isAdmin) return await sendTelegram(chatId, "⛔ Not authorized", false);
    await createBaseline(false, true); // only confirm to admin
  } else if (text === "/help") {
    await sendTelegram(chatId, "📖 Commands:\n/start, /status, /top10, /profit, /alerts\nAdmin only: /setbaseline, /clearhistory", false);
  } else {
    await sendTelegram(chatId, "Unknown command. Try /help", false);
  }

  res.sendStatus(200);
});

// --- CRON jobs ---
cron.schedule("0 6 * * *", () => createBaseline(true), { timezone: "Asia/Kolkata" });
cron.schedule("0 22 * * *", () => sendDailySummary(), { timezone: "Asia/Kolkata" });
setInterval(checkAlerts, config.REFRESH_INTERVAL);

// --- Start server ---
app.listen(config.PORT, () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
  if (!baseline) {
    console.log("⚠️ No baseline found. Creating one now...");
    createBaseline(true);
  }
});
