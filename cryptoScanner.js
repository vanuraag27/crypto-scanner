const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cron = require("node-cron");
const config = require("./config");

const app = express();
app.use(express.json());

let baselineData = {};
loadBaseline();

// --- Load Baseline from File ---
function loadBaseline() {
  try {
    if (fs.existsSync(config.BASELINE_FILE)) {
      baselineData = JSON.parse(fs.readFileSync(config.BASELINE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("❌ Error loading baseline:", err.message);
  }
}

// --- Save Baseline ---
function saveBaseline(data) {
  baselineData = data;
  fs.writeFileSync(config.BASELINE_FILE, JSON.stringify(data, null, 2));
}

// --- Telegram Helper ---
async function sendMessage(text, markdown = false) {
  if (!config.USE_TELEGRAM || !config.BOT_TOKEN || !config.CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text,
      parse_mode: markdown ? "Markdown" : undefined
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

// --- Fetch Top 100 Coins ---
async function fetchMarketData() {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
        params: { start: 1, limit: 100, convert: "USD" }
      }
    );
    return res.data.data;
  } catch (err) {
    console.error("❌ Error fetching market data:", err.response?.data || err.message);
    return [];
  }
}

// --- 6 AM Baseline Job ---
cron.schedule("0 6 * * *", async () => {
  console.log("⏰ Running 6 AM baseline job (IST)...");
  const coins = await fetchMarketData();
  if (!coins.length) return;

  const sorted = coins.sort(
    (a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h
  );
  const top10 = sorted.slice(0, 10).map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h
  }));

  const today = new Date().toISOString().split("T")[0];
  saveBaseline({ date: today, top10 });

  let msg = `✅ *Baseline set (6 AM IST ${today})*\nMonitoring top 10:\n`;
  top10.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
  });

  await sendMessage(msg, true);
}, { timezone: "Asia/Kolkata" });

// --- 10 PM Daily Summary ---
cron.schedule("0 22 * * *", async () => {
  console.log("⏰ Running 10 PM daily summary job (IST)...");
  if (!baselineData.top10) return;

  const coins = await fetchMarketData();
  if (!coins.length) return;

  const todayPrices = {};
  coins.forEach(c => { todayPrices[c.symbol] = c.quote.USD.price; });

  const summary = baselineData.top10.map(c => {
    const current = todayPrices[c.symbol] || c.price;
    const change = ((current - c.price) / c.price) * 100;
    return { symbol: c.symbol, current, change };
  });

  summary.sort((a, b) => b.change - a.change);

  let msg = `📊 *Daily Summary (10 PM IST ${baselineData.date})*\nPerformance ranked best → worst:\n`;
  summary.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} - $${c.current.toFixed(2)} | Change: ${c.change.toFixed(2)}%\n`;
  });

  await sendMessage(msg, true);
}, { timezone: "Asia/Kolkata" });

// --- Alerts Monitor (every 5 mins) ---
cron.schedule("*/5 * * * *", async () => {
  if (!baselineData.top10) return;
  const coins = await fetchMarketData();
  if (!coins.length) return;

  const todayPrices = {};
  coins.forEach(c => { todayPrices[c.symbol] = c.quote.USD.price; });

  for (const c of baselineData.top10) {
    const current = todayPrices[c.symbol];
    if (!current) continue;

    const change = ((current - c.price) / c.price) * 100;
    if (change <= config.ALERT_THRESHOLD) {
      await sendMessage(
        `⚠️ Alert: ${c.symbol} dropped ${change.toFixed(2)}%\nBaseline: $${c.price.toFixed(2)}\nNow: $${current.toFixed(2)}`
      );
    }
  }
}, { timezone: "Asia/Kolkata" });

// --- Telegram Commands via Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const text = msg.text.trim();
  if (text === "/status") {
    await sendMessage("✅ Scanner is running.\n6 AM baseline + 10 PM summary + alerts enabled.");
  } else if (text === "/top10") {
    if (!baselineData.top10) {
      await sendMessage("❌ No baseline set yet. Wait until 6 AM IST.");
    } else {
      let out = `📜 *Today's Baseline (6 AM ${baselineData.date})*\n`;
      baselineData.top10.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
      });
      await sendMessage(out, true);
    }
  } else if (text === "/help") {
    await sendMessage("📖 Commands:\n/status → Check scanner\n/top10 → Show today's baseline\n/help → Show help");
  }
  res.sendStatus(200);
});

// --- Start Server ---
app.listen(config.PORT, () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
});
