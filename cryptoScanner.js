const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const config = require("./config");

const app = express();
app.use(express.json());

const BASELINE_FILE = "./baseline.json";
let baseline = loadBaseline();

// Load baseline from file
function loadBaseline() {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE));
    }
  } catch (err) {
    console.error("❌ Error reading baseline:", err.message);
  }
  return { date: null, coins: [] };
}

// Save baseline
function saveBaseline(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
  baseline = data;
}

// Helper: send Telegram message
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

// Fetch top coins
async function fetchCoins(limit = 20) {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit, convert: "USD" }
  });
  return res.data.data.map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h
  }));
}

// Set baseline
async function setBaseline(manual = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!manual && baseline.date === today) return; // already set today

  const coins = await fetchCoins(20);
  const top10 = coins.sort((a, b) => b.change - a.change).slice(0, 10);
  baseline = { date: today, coins: top10 };
  saveBaseline(baseline);

  await sendMessage(
    config.CHAT_ID,
    `✅ *Baseline set (${manual ? "manual" : "auto"}) — ${today}*\nMonitoring top 10:\n` +
      top10.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`).join("\n"),
    true
  );
}

// --- Telegram Command Handler ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use /help for available commands.");
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 *Commands:*\n" +
        "/top10 → Today’s baseline list\n" +
        "/profit → Current profit vs baseline\n" +
        "/status → Scanner status\n" +
        "/alerts → Active alerts\n" +
        "/clearhistory (admin)\n/setbaseline (admin)\n/setadmin <id> (admin)\n/whoami"
    );
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Scanner running.\nBaseline date: ${baseline.date || "Not set"}`);
  } else if (text === "/top10") {
    if (!baseline.date) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    let out = `📊 *Top 10 Baseline (${baseline.date})*\n` +
      baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`).join("\n");
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline.date) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    const current = await fetchCoins(20);
    let out = "📈 *Profit since baseline*\n";
    baseline.coins.forEach(c => {
      const live = current.find(x => x.symbol === c.symbol);
      if (live) {
        const diff = ((live.price - c.price) / c.price) * 100;
        out += `${c.symbol}: ${diff.toFixed(2)}% (from $${c.price.toFixed(2)} → $${live.price.toFixed(2)})\n`;
      }
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/alerts") {
    await sendMessage(chatId, "🔔 Alerts system active. Drop alerts fire if ≥10% below baseline.");
  } else if (text === "/clearhistory") {
    if (userId !== config.ADMIN_ID) return await sendMessage(chatId, "❌ Admin only.");
    baseline = { date: null, coins: [] };
    saveBaseline(baseline);
    await sendMessage(chatId, "🗑️ History cleared.");
  } else if (text === "/setbaseline") {
    if (userId !== config.ADMIN_ID) return await sendMessage(chatId, "❌ Admin only.");
    await setBaseline(true);
  } else {
    await sendMessage(chatId, "Unknown command. Try /help");
  }

  res.sendStatus(200);
});

// --- Schedule tasks ---
cron.schedule("0 6 * * *", () => setBaseline(false), { timezone: "Asia/Kolkata" });

// Start server
app.listen(config.PORT, () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  if (!baseline.date) {
    console.log("⚠️ No baseline found. Will wait until 6 AM or admin /setbaseline.");
  } else {
    console.log(`📊 Loaded baseline for ${baseline.date}`);
  }
});
