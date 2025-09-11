const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const config = require("./config");

const app = express();
app.use(express.json());

// --- Storage helpers ---
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// files
let baseline = loadJSON("baseline.json", { date: "", coins: [] });
let alerted = loadJSON("alerted.json", { date: "", symbols: [] });

// reset alerts if day changed
function resetIfNewDay() {
  const today = new Date().toISOString().split("T")[0];
  if (alerted.date !== today) {
    alerted = { date: today, symbols: [] };
    saveJSON("alerted.json", alerted);
  }
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
    console.error("❌ Telegram error:", err.response?.data || err.message);
  }
}

// --- Market data ---
async function fetchTopCoins(limit = 20) {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit, convert: "USD" }
  });
  return res.data.data;
}

// --- Baseline setter ---
async function setBaseline(manual = false) {
  try {
    const coins = await fetchTopCoins(50);

    // rank by % change 24h
    const sorted = coins.sort((a, b) =>
      b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h
    );

    baseline = {
      date: new Date().toISOString().split("T")[0],
      coins: sorted.slice(0, 10).map(c => ({
        symbol: c.symbol,
        price: c.quote.USD.price,
        change: c.quote.USD.percent_change_24h
      }))
    };
    saveJSON("baseline.json", baseline);

    // reset alerts file
    alerted = { date: baseline.date, symbols: [] };
    saveJSON("alerted.json", alerted);

    const out = `✅ Baseline set (${manual ? "manual" : "6 AM IST"} ${baseline.date})\nMonitoring top 10:\n` +
      baseline.coins.map((c, i) =>
        `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`
      ).join("\n");

    await sendMessage(config.CHAT_ID, out);
    return out;
  } catch (err) {
    console.error("❌ Baseline error:", err.response?.data || err.message);
  }
}

// --- Monitoring loop ---
async function monitorDrops() {
  resetIfNewDay();
  if (!baseline.coins.length) return; // no baseline

  try {
    const coins = await fetchTopCoins(50);
    const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    for (const base of baseline.coins) {
      const live = coins.find(c => c.symbol === base.symbol);
      if (!live) continue;

      const currentPrice = live.quote.USD.price;
      const dropPct = ((currentPrice - base.price) / base.price) * 100;

      if (dropPct <= -10 && !alerted.symbols.includes(base.symbol)) {
        const alertMsg =
          `🚨 ALERT ${base.symbol}\n` +
          `Drop: ${dropPct.toFixed(2)}%\n` +
          `Baseline: $${base.price.toFixed(2)}\n` +
          `Now: $${currentPrice.toFixed(2)}\n` +
          `⏰ ${now} IST`;

        await sendMessage(config.CHAT_ID, alertMsg, false);
        alerted.symbols.push(base.symbol);
        saveJSON("alerted.json", alerted);
      }
    }
  } catch (err) {
    console.error("❌ Monitor error:", err.response?.data || err.message);
  }
}

// --- Cron jobs ---
cron.schedule("0 6 * * *", () => setBaseline(false), { timezone: "Asia/Kolkata" });
cron.schedule("*/5 * * * *", monitorDrops, { timezone: "Asia/Kolkata" }); // every 5m
cron.schedule("0 22 * * *", async () => {
  if (!baseline.coins.length) return;
  const coins = await fetchTopCoins(50);
  const ranked = baseline.coins.map(base => {
    const live = coins.find(c => c.symbol === base.symbol);
    if (!live) return null;
    const changePct = ((live.quote.USD.price - base.price) / base.price) * 100;
    return { symbol: base.symbol, profit: changePct };
  }).filter(Boolean).sort((a, b) => b.profit - a.profit);

  const out = `📊 Daily Summary ${baseline.date}\n` +
    ranked.map((c, i) => `${i + 1}. ${c.symbol} ${c.profit.toFixed(2)}%`).join("\n");
  await sendMessage(config.CHAT_ID, out);
}, { timezone: "Asia/Kolkata" });

// --- Telegram webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg?.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Commands: /top10 /profit /alert /setbaseline /help");
  } else if (text === "/top10") {
    if (!baseline.coins.length) {
      const out = await setBaseline(true);
      await sendMessage(chatId, out);
    } else {
      const out = `📌 Top 10 baseline ${baseline.date}\n` +
        baseline.coins.map((c, i) =>
          `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)}`
        ).join("\n");
      await sendMessage(chatId, out);
    }
  } else if (text === "/profit") {
    if (!baseline.coins.length) {
      await sendMessage(chatId, "Baseline not set yet.");
    } else {
      const coins = await fetchTopCoins(50);
      const ranked = baseline.coins.map(base => {
        const live = coins.find(c => c.symbol === base.symbol);
        if (!live) return null;
        const pct = ((live.quote.USD.price - base.price) / base.price) * 100;
        return { symbol: base.symbol, profit: pct };
      }).filter(Boolean).sort((a, b) => b.profit - a.profit);

      const out = `📈 Profit since 6 AM (${baseline.date})\n` +
        ranked.map((c, i) => `${i + 1}. ${c.symbol} ${c.profit.toFixed(2)}%`).join("\n");
      await sendMessage(chatId, out);
    }
  } else if (text === "/alert") {
    if (!baseline.coins.length) {
      await sendMessage(chatId, "Baseline not set yet.");
    } else {
      const coins = await fetchTopCoins(50);
      const alerts = baseline.coins.map(base => {
        const live = coins.find(c => c.symbol === base.symbol);
        if (!live) return null;
        const dropPct = ((live.quote.USD.price - base.price) / base.price) * 100;
        if (dropPct <= -10) {
          return `${base.symbol}: ${dropPct.toFixed(2)}% (baseline $${base.price.toFixed(2)} → now $${live.quote.USD.price.toFixed(2)})`;
        }
        return null;
      }).filter(Boolean);

      if (!alerts.length) {
        await sendMessage(chatId, "✅ No active alerts (no coin down ≥10%).");
      } else {
        const out = `🚨 Active Alerts:\n` + alerts.join("\n");
        await sendMessage(chatId, out);
      }
    }
  } else if (text === "/setbaseline") {
    if (msg.from.id.toString() === config.ADMIN_ID) {
      const out = await setBaseline(true);
      await sendMessage(chatId, "✅ Baseline refreshed manually.");
    } else {
      await sendMessage(chatId, "⛔ You are not authorized.");
    }
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Try /help.");
  }

  res.sendStatus(200);
});

// --- Start server ---
app.listen(config.PORT, () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
});
