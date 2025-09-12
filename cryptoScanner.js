const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
app.use(express.json());

const baselinePath = path.join(__dirname, "baseline.json");
let baseline = null;
let alertedCoins = new Set();

// --- Load baseline if exists ---
if (fs.existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch {
    baseline = null;
  }
}

// --- Telegram Helper ---
async function sendMessage(chatId, text, markdown = false) {
  if (!config.BOT_TOKEN) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: markdown ? "Markdown" : undefined,
      }
    );
  } catch (err) {
    console.error("Telegram sendMessage error:", err.response?.data || err.message);
  }
}

// --- Fetch Top 20 Coins from CMC ---
async function fetchTopCoins(limit = 20) {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
        params: { start: 1, limit, convert: "USD" },
      }
    );
    return res.data.data.map(c => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h,
    }));
  } catch (err) {
    console.error("CMC fetch error:", err.response?.data || err.message);
    return [];
  }
}

// --- Baseline Functions ---
async function setBaseline(auto = false) {
  const coins = await fetchTopCoins(50);
  if (!coins.length) return;

  const top10 = coins
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  baseline = {
    time: new Date().toISOString(),
    coins: top10,
  };

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  alertedCoins.clear();

  if (config.USE_TELEGRAM) {
    const msg = `${
      auto ? "✅ *Baseline auto-set (6 AM IST)*" : "✅ *Baseline set manually*"
    }\nMonitoring top 10:\n` +
      top10
        .map(
          (c, i) =>
            `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`
        )
        .join("\n");

    await sendMessage(config.CHAT_ID, msg, true);
  }
}

// --- Alerts ---
async function checkAlerts() {
  if (!baseline) return;
  const current = await fetchTopCoins(50);
  if (!current.length) return;

  for (let base of baseline.coins) {
    const now = current.find(c => c.symbol === base.symbol);
    if (!now) continue;

    const drop = ((now.price - base.price) / base.price) * 100;
    if (drop <= -10 && !alertedCoins.has(base.symbol)) {
      alertedCoins.add(base.symbol);
      const alertMsg = `⚠️ *ALERT*: ${base.symbol} dropped ${drop.toFixed(2)}%\n` +
        `Baseline: $${base.price.toFixed(2)}\n` +
        `Now: $${now.price.toFixed(2)}\n` +
        `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
      await sendMessage(config.CHAT_ID, alertMsg, true);
    }
  }
}

// --- Daily Summary ---
async function sendSummary() {
  if (!baseline) return;
  const current = await fetchTopCoins(50);
  if (!current.length) return;

  const perf = baseline.coins.map(base => {
    const now = current.find(c => c.symbol === base.symbol);
    return {
      symbol: base.symbol,
      baseline: base.price,
      current: now ? now.price : base.price,
      profit: now ? ((now.price - base.price) / base.price) * 100 : 0,
    };
  });

  const ranked = perf.sort((a, b) => b.profit - a.profit);

  const msg = `📊 *Daily Summary*\n⏰ ${new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  })}\n\n` + ranked
    .map(
      (c, i) =>
        `${i + 1}. ${c.symbol} → ${c.profit.toFixed(2)}% (Baseline: $${c.baseline.toFixed(
          2
        )}, Now: $${c.current.toFixed(2)})`
    )
    .join("\n");

  await sendMessage(config.CHAT_ID, msg, true);
}

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const isAdmin = String(chatId) === String(config.ADMIN_ID);

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use /help for commands.", false);
  } else if (text === "/help") {
    await sendMessage(
      chatId,
      "📖 Commands:\n/start\n/help\n/status\n/top10\n/profit\n/alerts\n/clearhistory (admin)\n/setbaseline (admin)",
      false
    );
  } else if (text === "/status") {
    await sendMessage(
      chatId,
      baseline
        ? `✅ Baseline set at ${baseline.time}`
        : "⚠️ Baseline not set yet.",
      false
    );
  } else if (text === "/top10") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    let out = `📊 *Top 10 (Baseline)*\n`;
    baseline.coins.forEach(
      (c, i) =>
        (out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(
          2
        )} (24h: ${c.change.toFixed(2)}%)\n`)
    );
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    const current = await fetchTopCoins(50);
    const perf = baseline.coins.map(base => {
      const now = current.find(c => c.symbol === base.symbol);
      return {
        symbol: base.symbol,
        profit: now ? ((now.price - base.price) / base.price) * 100 : 0,
      };
    });
    const ranked = perf.sort((a, b) => b.profit - a.profit);
    let out = `📈 *Profit Since Baseline*\n`;
    ranked.forEach(
      (c, i) => (out += `${i + 1}. ${c.symbol} → ${c.profit.toFixed(2)}%\n`)
    );
    await sendMessage(chatId, out, true);
  } else if (text === "/alerts") {
    await sendMessage(chatId, "🔔 Alerts active: drop ≥10% since baseline", false);
  } else if (text === "/clearhistory" && isAdmin) {
    baseline = null;
    fs.writeFileSync(baselinePath, JSON.stringify({}, null, 2));
    await sendMessage(chatId, "🗑️ History cleared (admin only).", false);
  } else if (text === "/setbaseline" && isAdmin) {
    await setBaseline(false);
  } else {
    await sendMessage(chatId, "Unknown command. Try /help", false);
  }

  res.sendStatus(200);
});

// --- Scheduler ---
function scheduleTasks() {
  setInterval(checkAlerts, 5 * 60 * 1000); // every 5 minutes
  setInterval(() => {
    const now = new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
    });
    if (now.startsWith("06:00:00")) setBaseline(true);
    if (now.startsWith("22:00:00")) sendSummary();
  }, 60 * 1000);
}

// --- Start Server ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
  scheduleTasks();
});
