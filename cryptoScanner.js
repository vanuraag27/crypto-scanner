const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const config = require("./config");

const app = express();
app.use(express.json());

const BASELINE_FILE = path.join(__dirname, "baseline.json");

let baseline = { date: "", coins: [] };

// --- Load baseline ---
function loadBaseline() {
  if (fs.existsSync(BASELINE_FILE)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  }
}

// --- Save baseline ---
function saveBaseline() {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

// --- Send Telegram message ---
async function sendMessage(chatId, text, markdown = false) {
  if (!config.BOT_TOKEN) return;
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

// --- Fetch coins from CMC ---
async function fetchCoins(limit = 50) {
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
    params: { start: 1, limit, convert: "USD" }
  });
  return res.data.data.map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h,
    volume: c.quote.USD.volume_24h
  }));
}

// --- Set new baseline ---
async function setBaseline(manual = false) {
  const coins = await fetchCoins(50);
  const top10 = coins
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  baseline = {
    date: new Date().toLocaleDateString("en-IN"),
    coins: top10
  };
  saveBaseline();

  let out = `✅ *Baseline set (${manual ? "manual" : "6 AM IST"} ${baseline.date})*\nMonitoring top 10:\n`;
  top10.forEach((c, i) => {
    out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
  });

  if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, out, true);
  console.log(out);
}

// --- Monitor for -10% drop ---
async function monitorAlerts() {
  if (!baseline.coins.length) return;
  const latest = await fetchCoins(50);

  baseline.coins.forEach(base => {
    const coin = latest.find(c => c.symbol === base.symbol);
    if (coin) {
      const drop = ((coin.price - base.price) / base.price) * 100;
      if (drop <= -10) {
        sendMessage(
          config.CHAT_ID,
          `🚨 Alert: ${coin.symbol} dropped ${drop.toFixed(2)}%\nBaseline: $${base.price.toFixed(2)}\nNow: $${coin.price.toFixed(2)}\nTime: ${new Date().toLocaleTimeString("en-IN")}`
        );
      }
    }
  });
}

// --- Daily summary at 10 PM ---
async function dailySummary() {
  if (!baseline.coins.length) return;
  const latest = await fetchCoins(50);

  let summary = `📊 *Daily Summary (${baseline.date})*\nRanked best → worst:\n`;
  const ranked = baseline.coins
    .map(base => {
      const coin = latest.find(c => c.symbol === base.symbol);
      if (!coin) return null;
      const profit = ((coin.price - base.price) / base.price) * 100;
      return { ...coin, profit };
    })
    .filter(Boolean)
    .sort((a, b) => b.profit - a.profit);

  ranked.forEach((c, i) => {
    summary += `${i + 1}. ${c.symbol} - ${c.profit.toFixed(2)}% (Now: $${c.price.toFixed(2)})\n`;
  });

  if (config.USE_TELEGRAM) await sendMessage(config.CHAT_ID, summary, true);
  console.log(summary);
}

// --- Auto webhook setup ---
async function setWebhook() {
  if (!config.BOT_TOKEN) return;
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    console.log(`✅ Webhook set: ${webhookUrl}`);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
}

// --- Handle Telegram commands ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use `/help` for commands.", true);
  } else if (text === "/help") {
    await sendMessage(chatId,
      "📖 *Commands:*\n" +
      "/top10 → Show today’s baseline\n" +
      "/profit → Show profit since 6 AM\n" +
      "/status → Check scanner status\n" +
      "/setbaseline → Reset baseline (admin only)\n" +
      "/clearhistory → Clear baseline (admin only)",
      true
    );
  } else if (text === "/top10") {
    if (!baseline.coins.length) {
      await setBaseline(true); // auto set if missing
    }
    let out = `*Top 10 Baseline (${baseline.date})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline.coins.length) {
      await sendMessage(chatId, "Baseline not set yet.");
    } else {
      const latest = await fetchCoins(50);
      let out = `📈 *Profit since 6 AM (${baseline.date})*\n`;
      const ranked = baseline.coins.map(base => {
        const coin = latest.find(c => c.symbol === base.symbol);
        if (!coin) return null;
        const profit = ((coin.price - base.price) / base.price) * 100;
        return { ...coin, profit };
      }).filter(Boolean).sort((a, b) => b.profit - a.profit);
      ranked.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol} - ${c.profit.toFixed(2)}% (Now: $${c.price.toFixed(2)})\n`;
      });
      await sendMessage(chatId, out, true);
    }
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Scanner is running.\nBaseline date: ${baseline.date || "Not set"}`);
  } else if (text === "/setbaseline") {
    if (msg.from.id.toString() === config.ADMIN_ID) {
      await setBaseline(true);
    } else {
      await sendMessage(chatId, "⛔ You are not authorized to use this command.");
    }
  } else if (text === "/clearhistory") {
    if (msg.from.id.toString() === config.ADMIN_ID) {
      baseline = { date: "", coins: [] };
      saveBaseline();
      await sendMessage(chatId, "🗑️ Baseline cleared.");
    } else {
      await sendMessage(chatId, "⛔ You are not authorized to use this command.");
    }
  }

  res.sendStatus(200);
});

// --- Scheduler ---
schedule.scheduleJob("0 6 * * *", () => setBaseline(false));   // 6 AM IST
schedule.scheduleJob("0 22 * * *", () => dailySummary());      // 10 PM IST
schedule.scheduleJob("*/10 * * * *", () => monitorAlerts());   // Every 10 mins

// --- Init ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();
  loadBaseline();
  if (!baseline.coins.length) {
    console.log("⚠️ No baseline found. Creating one now...");
    await setBaseline(true);
  }
  console.log("🔍 Scanner initialized");
});
