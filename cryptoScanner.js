const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
app.use(express.json());

// ------------------- Helpers -------------------
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, file)));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(data, null, 2));
}
function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ------------------- State -------------------
let baseline = loadJSON("baseline.json", { date: null, coins: [] });
let alerted = loadJSON("alerted.json", { date: null, symbols: [], lastAlertTime: null });

// ------------------- Telegram -------------------
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

async function setWebhook() {
  if (!config.BOT_TOKEN) return;
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    if (res.data.ok) console.log(`✅ Webhook set: ${webhookUrl}`);
    else console.error("❌ Failed to set webhook:", res.data);
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
}

// ------------------- Scanner -------------------
async function fetchTopCoins(limit = 20) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
    });
    return res.data.data.map((c) => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h,
      name: c.name,
    }));
  } catch (err) {
    console.error("❌ Error fetching CMC data:", err.response?.data || err.message);
    return [];
  }
}

async function setBaselineCoins() {
  const coins = await fetchTopCoins(50);
  if (!coins.length) return;

  const top10 = coins.sort((a, b) => b.change - a.change).slice(0, 10);

  baseline = { date: istNow().split(",")[0], coins: top10 };
  saveJSON("baseline.json", baseline);

  alerted = { date: baseline.date, symbols: [], lastAlertTime: null };
  saveJSON("alerted.json", alerted);

  let out = `✅ *Baseline set (${baseline.date} IST)*\nMonitoring top 10:\n`;
  top10.forEach((c, i) => {
    out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
  });
  await sendMessage(config.CHAT_ID, out, true);
  console.log("✅ Baseline set and saved");
}

async function checkAlerts() {
  if (!baseline.coins.length) return;

  const coins = await fetchTopCoins(50);
  if (!coins.length) return;

  for (const base of baseline.coins) {
    const current = coins.find((c) => c.symbol === base.symbol);
    if (!current) continue;

    const drop = ((current.price - base.price) / base.price) * 100;
    if (drop <= -10 && !alerted.symbols.includes(base.symbol)) {
      alerted.symbols.push(base.symbol);
      alerted.lastAlertTime = istNow();
      saveJSON("alerted.json", alerted);

      const msg =
        `⚠️ *ALERT*: ${base.symbol} dropped ${drop.toFixed(2)}%\n` +
        `Baseline: $${base.price.toFixed(2)}\n` +
        `Now: $${current.price.toFixed(2)}\n` +
        `⏰ ${alerted.lastAlertTime} IST`;
      await sendMessage(config.CHAT_ID, msg, true);
      console.log(`🚨 Alert sent for ${base.symbol}`);
    }
  }
}

// ------------------- Telegram Webhook -------------------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg?.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const userId = msg.from.id.toString();

  if (text === "/start") {
    await sendMessage(chatId,
      "👋 Welcome! Commands:\n" +
      "/top10 – Show today’s baseline\n" +
      "/profit – Profit % since baseline\n" +
      "/alerts – Show active alerts\n" +
      "/status – Scanner status\n" +
      "/setbaseline – Refresh baseline (admin)\n" +
      "/clearhistory – Reset today’s alerts (admin)\n" +
      "/help – Show this help"
    );
  } else if (text === "/help") {
    await sendMessage(chatId,
      "📖 *Available Commands:*\n\n" +
      "/top10 – Today’s baseline\n" +
      "/profit – Profit % since 6 AM\n" +
      "/alerts – Show active alerts\n" +
      "/status – Scanner status\n" +
      "/setbaseline – Refresh baseline (admin)\n" +
      "/clearhistory – Reset today’s alerts (admin)\n" +
      "/help – Show this help",
      true
    );
  } else if (text === "/status") {
    const lastBaseline = baseline.date || "Not set";
    const now = istNow();
    const lastAlert = alerted.lastAlertTime || "No alerts today";
    await sendMessage(chatId,
      `✅ Scanner running\n` +
      `Baseline date: ${lastBaseline}\n` +
      `Last checked: ${now} IST\n` +
      `Last alert: ${lastAlert}`
    );
  } else if (text === "/clearhistory") {
    if (userId === config.ADMIN_ID) {
      alerted = { date: baseline.date, symbols: [], lastAlertTime: null };
      saveJSON("alerted.json", alerted);
      await sendMessage(chatId, "🧹 Alert history cleared for today.");
    } else {
      await sendMessage(chatId, "⛔ You are not authorized.");
    }
  } else if (text === "/setbaseline") {
    if (userId === config.ADMIN_ID) {
      await setBaselineCoins();
    } else {
      await sendMessage(chatId, "⛔ You are not authorized.");
    }
  } else if (text === "/top10") {
    if (!baseline.coins.length) {
      await setBaselineCoins();
      return await sendMessage(chatId, "Baseline was missing. Auto-created for today.");
    }
    let out = `*Top 10 baseline (${baseline.date})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline.coins.length) return await sendMessage(chatId, "Baseline not set yet.");
    const coins = await fetchTopCoins(50);
    const profitList = baseline.coins.map((base) => {
      const current = coins.find((c) => c.symbol === base.symbol);
      if (!current) return null;
      const change = ((current.price - base.price) / base.price) * 100;
      return { ...base, currentPrice: current.price, profit: change };
    }).filter(Boolean);
    const ranked = profitList.sort((a, b) => b.profit - a.profit);
    let out = `📈 *Profit since ${baseline.date} (6 AM baseline)*\n`;
    ranked.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} ${c.profit.toFixed(2)}% (Now $${c.currentPrice.toFixed(2)})\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/alert" || text === "/alerts") {
    if (!baseline.coins.length) return await sendMessage(chatId, "Baseline not set yet.");
    if (!alerted.symbols.length) return await sendMessage(chatId, "✅ No alerts triggered yet.");
    let out = `⚠️ Alerts triggered today (${baseline.date}):\n`;
    alerted.symbols.forEach((s, i) => {
      out += `${i + 1}. ${s}\n`;
    });
    out += `\nLast alert at: ${alerted.lastAlertTime || "N/A"}`;
    await sendMessage(chatId, out);
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Try /help");
  }

  res.sendStatus(200);
});

// ------------------- Scheduler -------------------
function scheduleJobs() {
  setInterval(async () => {
    const now = new Date();
    const istHour = parseInt(
      now.toLocaleString("en-IN", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    );
    const istMinute = parseInt(
      now.toLocaleString("en-IN", { minute: "2-digit", timeZone: "Asia/Kolkata" })
    );

    if (istHour === 6 && istMinute === 0 && baseline.date !== istNow().split(",")[0]) {
      await setBaselineCoins();
    }

    if (istMinute % 10 === 0) {
      await checkAlerts();
    }

    if (istHour === 22 && istMinute === 0) {
      if (!baseline.coins.length) return;
      const coins = await fetchTopCoins(50);
      const summary = baseline.coins.map((base) => {
        const current = coins.find((c) => c.symbol === base.symbol);
        if (!current) return null;
        const change = ((current.price - base.price) / base.price) * 100;
        return { ...base, currentPrice: current.price, profit: change };
      }).filter(Boolean).sort((a, b) => b.profit - a.profit);

      let out = `🌙 *Daily Summary (${baseline.date})*\nRanked best → worst:\n`;
      summary.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} ${c.profit.toFixed(2)}% (Now $${c.currentPrice.toFixed(2)})\n`;
      });
      await sendMessage(config.CHAT_ID, out, true);
    }
  }, 60 * 1000);
}

// ------------------- Start -------------------
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();
  console.log("🔍 Scanner initialized");

  if (!baseline.coins.length) {
    console.log("⚠️ No baseline found. Creating one now...");
    await setBaselineCoins();
  }

  scheduleJobs();
});
