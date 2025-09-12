const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const config = require("./config");

const app = express();
app.use(express.json());

const BASELINE_FILE = path.join(__dirname, "baseline.json");
let baseline = null;
let alertedCoins = new Set();

// --- Helpers ---
function loadBaseline() {
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    } catch (e) {
      console.error("❌ Error reading baseline.json:", e.message);
    }
  }
}

function saveBaseline() {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

async function sendMessage(chatId, text, markdown = false) {
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

async function fetchTopCoins() {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit: 50, convert: "USD" },
  });
  return res.data.data;
}

// --- Baseline Logic ---
async function setBaseline(manual = false) {
  try {
    const coins = await fetchTopCoins();
    const top10 = coins
      .sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h)
      .slice(0, 10)
      .map((c) => ({
        symbol: c.symbol,
        price: c.quote.USD.price,
        change: c.quote.USD.percent_change_24h,
      }));

    baseline = {
      date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      coins: top10,
    };
    saveBaseline();

    let out = `✅ *Baseline set (${manual ? "manual" : "auto"} @ ${baseline.date})*\nMonitoring top 10:\n`;
    top10.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });

    await sendMessage(config.CHAT_ID, out, true);
    console.log("✅ Baseline set and saved");
  } catch (err) {
    console.error("❌ Error setting baseline:", err.response?.data || err.message);
  }
}

async function checkAlerts() {
  if (!baseline || !baseline.coins) return;
  try {
    const coins = await fetchTopCoins();
    for (let base of baseline.coins) {
      const live = coins.find((c) => c.symbol === base.symbol);
      if (!live) continue;

      const drop = ((live.quote.USD.price - base.price) / base.price) * 100;
      if (drop <= -10 && !alertedCoins.has(base.symbol)) {
        alertedCoins.add(base.symbol);
        const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        const msg =
          `⚠️ *ALERT*\n${base.symbol} dropped ${drop.toFixed(2)}% since baseline!\n\n` +
          `Baseline: $${base.price.toFixed(2)}\n` +
          `Now: $${live.quote.USD.price.toFixed(2)}\n` +
          `🕒 ${now}`;
        await sendMessage(config.CHAT_ID, msg, true);
      }
    }
  } catch (err) {
    console.error("❌ Error checking alerts:", err.response?.data || err.message);
  }
}

// --- Telegram Command Handler ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use /help to see available commands.");
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 *Commands:*\n\n" +
        "/top10 – Show baseline top 10\n" +
        "/profit – Show profit vs baseline\n" +
        "/alert – Show active alerts\n" +
        "/status – Show scanner status\n" +
        "/setbaseline – Admin only\n" +
        "/clearhistory – Admin only",
      true
    );
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Scanner running.\nBaseline: ${baseline?.date || "Not set yet"}`);
  } else if (text === "/top10") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    let out = `📊 *Baseline Top 10 (${baseline.date})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)}\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    const coins = await fetchTopCoins();
    let profits = baseline.coins.map((b) => {
      const live = coins.find((c) => c.symbol === b.symbol);
      const gain = ((live.quote.USD.price - b.price) / b.price) * 100;
      return { symbol: b.symbol, gain };
    });
    profits.sort((a, b) => b.gain - a.gain);
    let out = `📈 *Profit vs Baseline (${baseline.date})*\n`;
    profits.forEach((p, i) => {
      out += `${i + 1}. ${p.symbol} ${p.gain.toFixed(2)}%\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/alert") {
    if (alertedCoins.size === 0) {
      await sendMessage(chatId, "✅ No active alerts.");
    } else {
      await sendMessage(chatId, "⚠️ Active Alerts: " + [...alertedCoins].join(", "));
    }
  } else if (text === "/setbaseline" && msg.from.id.toString() === config.ADMIN_ID) {
    await setBaseline(true);
  } else if (text === "/clearhistory" && msg.from.id.toString() === config.ADMIN_ID) {
    baseline = null;
    saveBaseline();
    alertedCoins.clear();
    await sendMessage(chatId, "🗑️ History cleared (admin only).");
  } else {
    await sendMessage(chatId, "❌ Unknown command. Try /help.");
  }

  res.sendStatus(200);
});

// --- Scheduling ---
function scheduleTasks() {
  // Baseline daily at 6 AM IST
  schedule.scheduleJob({ hour: 6, minute: 0, tz: "Asia/Kolkata" }, () => setBaseline(false));

  // Summary daily at 10 PM IST
  schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
    if (!baseline) return;
    const coins = await fetchTopCoins();
    let report = `📊 *Daily Summary (${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})*\n`;
    let perf = baseline.coins.map((b) => {
      const live = coins.find((c) => c.symbol === b.symbol);
      const gain = ((live.quote.USD.price - b.price) / b.price) * 100;
      return { symbol: b.symbol, gain };
    });
    perf.sort((a, b) => b.gain - a.gain);
    perf.forEach((p, i) => {
      report += `${i + 1}. ${p.symbol} ${p.gain.toFixed(2)}%\n`;
    });
    await sendMessage(config.CHAT_ID, report, true);
  });

  // Check alerts every 5 minutes
  setInterval(checkAlerts, 5 * 60 * 1000);
}

// --- Startup ---
loadBaseline();

app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");

  // ✅ Auto-register webhook
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    if (res.data.ok) {
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } else {
      console.error("❌ Webhook setup failed:", res.data);
    }
  } catch (err) {
    console.error("❌ Error setting webhook:", err.response?.data || err.message);
  }

  scheduleTasks();
});
