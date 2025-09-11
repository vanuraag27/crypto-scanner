const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
app.use(express.json());

const baselineFile = path.join(__dirname, "baseline.json");
const alertsFile = path.join(__dirname, "alerts.json");

// --- Utilities ---
function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return null;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- State ---
let baseline = loadJSON(baselineFile);
let triggeredAlerts = loadJSON(alertsFile) || [];

// --- Telegram ---
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

async function setWebhook() {
  if (!config.BOT_TOKEN || !config.BASE_URL) return;
  const url = `${config.BASE_URL}/webhook`;
  try {
    await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${url}`);
    console.log(`✅ Webhook set: ${url}`);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
}

// --- Data Fetch ---
async function fetchTopCoins(limit = 20) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" }
    });
    return res.data.data.map(c => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h
    }));
  } catch (err) {
    console.error("❌ CMC error:", err.response?.data || err.message);
    return null;
  }
}

// --- Baseline ---
async function setBaseline() {
  const coins = await fetchTopCoins(50);
  if (!coins) return;
  const top10 = [...coins].sort((a, b) => b.change - a.change).slice(0, 10);
  baseline = {
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    coins: top10
  };
  saveJSON(baselineFile, baseline);
  triggeredAlerts = [];
  saveJSON(alertsFile, triggeredAlerts);
  await sendMessage(config.CHAT_ID, `✅ *Baseline set (${baseline.time})*\nMonitoring top 10:\n` +
    top10.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`).join("\n"), true);
  console.log("✅ Baseline set and saved");
}

// --- Alerts ---
async function checkAlerts() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) return;
  const current = await fetchTopCoins(50);
  if (!current) return;

  for (let c of baseline.coins) {
    const live = current.find(x => x.symbol === c.symbol);
    if (!live) continue;
    const drop = ((live.price - c.price) / c.price) * 100;
    if (drop <= -10 && !triggeredAlerts.find(a => a.symbol === c.symbol)) {
      const alert = {
        symbol: c.symbol,
        baseline: c.price,
        current: live.price,
        drop,
        time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      };
      triggeredAlerts.push(alert);
      saveJSON(alertsFile, triggeredAlerts);
      await sendMessage(config.CHAT_ID,
        `🚨 *ALERT*: ${c.symbol} dropped ${drop.toFixed(2)}%\nBaseline: $${c.price.toFixed(2)}\nNow: $${live.price.toFixed(2)}\n⏰ ${alert.time}`,
        true
      );
    }
  }
}

// --- Daily Summary ---
async function dailySummary() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) return;
  const current = await fetchTopCoins(50);
  if (!current) return;
  const ranked = baseline.coins.map(c => {
    const live = current.find(x => x.symbol === c.symbol);
    if (!live) return null;
    const profit = ((live.price - c.price) / c.price) * 100;
    return { ...c, current: live.price, profit };
  }).filter(Boolean).sort((a, b) => b.profit - a.profit);

  await sendMessage(config.CHAT_ID,
    `📊 *Daily Summary (${new Date().toLocaleDateString("en-IN")})*\n` +
    ranked.map((c, i) => `${i + 1}. ${c.symbol} | Δ ${c.profit.toFixed(2)}% | $${c.price.toFixed(2)} → $${c.current.toFixed(2)}`).join("\n"),
    true
  );
}

// --- Scheduler ---
async function dailyScheduler() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const hr = now.getHours(), min = now.getMinutes();
  if (hr === 6 && min === 0) await setBaseline();
  if (hr === 22 && min === 0) await dailySummary();
}

// --- Telegram Commands ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const isAdmin = msg.from.username === config.ADMIN_USER;

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Commands:\n/top10 → Today’s top10\n/profit → Gains since baseline\n/status → Bot status\n/alerts → View alerts\n/help → Show help");
  } else if (text === "/help") {
    await sendMessage(chatId, "📖 Commands:\n/start, /help, /status, /top10, /profit, /alerts\nAdmin: /setbaseline, /clearhistory");
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Running\nBaseline: ${baseline?.time || "Not set"}`);
  } else if (text === "/alerts") {
    if (!triggeredAlerts.length) {
      await sendMessage(chatId, "✅ No alerts so far.");
    } else {
      await sendMessage(chatId,
        "🚨 Alerts:\n" + triggeredAlerts.map(a => `${a.symbol} ↓ ${a.drop.toFixed(2)}% | $${a.baseline.toFixed(2)} → $${a.current.toFixed(2)} | ${a.time}`).join("\n")
      );
    }
  } else if (text === "/top10") {
    if (!baseline?.coins) await setBaseline();
    let out = `*Top 10 Baseline (${baseline.time})*\n` +
      baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`).join("\n");
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline?.coins) return await sendMessage(chatId, "Baseline not set yet.");
    const current = await fetchTopCoins(50);
    const ranked = baseline.coins.map(c => {
      const live = current.find(x => x.symbol === c.symbol);
      if (!live) return null;
      const profit = ((live.price - c.price) / c.price) * 100;
      return { ...c, current: live.price, profit };
    }).filter(Boolean).sort((a, b) => b.profit - a.profit);

    let out = `*Profit since ${baseline.time}*\n` +
      ranked.map((c, i) => `${i + 1}. ${c.symbol} | Δ ${c.profit.toFixed(2)}% | $${c.price.toFixed(2)} → $${c.current.toFixed(2)}`).join("\n");
    await sendMessage(chatId, out, true);
  } else if (text === "/setbaseline" && isAdmin) {
    await setBaseline();
  } else if (text === "/clearhistory" && isAdmin) {
    triggeredAlerts = [];
    saveJSON(alertsFile, triggeredAlerts);
    await sendMessage(chatId, "🧹 Alert history cleared.");
  } else {
    await sendMessage(chatId, "❓ Unknown command. Try /help");
  }

  res.sendStatus(200);
});

// --- Startup ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();
  if (!baseline || !baseline.coins) {
    console.log("⚠️ No baseline found. Creating one now...");
    await setBaseline();
  }
  setInterval(checkAlerts, 60 * 1000);
  setInterval(dailyScheduler, 60 * 1000);
  console.log("🔍 Scanner initialized");
});
