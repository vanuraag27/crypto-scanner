const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
app.use(express.json());

const baselineFile = path.join(__dirname, "baseline.json");
const alertsFile = path.join(__dirname, "alerts.json");

let baseline = loadJSON(baselineFile) || null;
let triggeredAlerts = loadJSON(alertsFile) || [];

// --- Utility to read/write JSON ---
function loadJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (err) {
    console.error("❌ Error reading", file, err.message);
  }
  return null;
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("❌ Error writing", file, err.message);
  }
}

// --- Telegram Helpers ---
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

// --- Webhook Setup ---
async function setWebhook() {
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    if (res.data.ok) {
      console.log(`✅ Webhook set: ${webhookUrl}`);
    } else {
      console.error("❌ Failed to set webhook:", res.data);
    }
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
}

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await sendMessage(chatId, "👋 Welcome! Use /help to see available commands.");
  } else if (text === "/help") {
    await sendMessage(chatId,
      "📖 *Commands:*\n\n" +
      "/status - Scanner status\n" +
      "/top10 - Show baseline list\n" +
      "/profit - Show % profit/loss vs baseline\n" +
      "/alerts - Show triggered alerts\n" +
      "/setbaseline - Refresh baseline (admin only)\n" +
      "/clearhistory - Clear alerts (admin only)",
      true
    );
  } else if (text === "/status") {
    await sendMessage(chatId, `✅ Scanner is running.\nBaseline set: ${baseline ? baseline.time : "Not yet"}`);
  } else if (text === "/top10") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    let out = `*📊 Baseline (set ${baseline.time})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price} (24h: ${c.change}%)\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline) return await sendMessage(chatId, "⚠️ Baseline not set yet.");
    const current = await fetchTopCoins();
    if (!current) return await sendMessage(chatId, "❌ Could not fetch live data.");
    let perf = baseline.coins.map(c => {
      const live = current.find(x => x.symbol === c.symbol);
      if (!live) return null;
      return {
        symbol: c.symbol,
        baseline: c.price,
        current: live.price,
        change: ((live.price - c.price) / c.price) * 100
      };
    }).filter(Boolean).sort((a,b) => b.change - a.change);

    let out = `*📈 Profit/Loss vs Baseline (${baseline.time})*\n`;
    perf.forEach((p,i) => {
      out += `${i+1}. ${p.symbol} - ${p.change.toFixed(2)}% (B: $${p.baseline}, Now: $${p.current})\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/alerts") {
    if (!triggeredAlerts.length) return await sendMessage(chatId, "✅ No alerts triggered today.");
    let out = "*🚨 Triggered Alerts:*\n";
    triggeredAlerts.forEach((a,i) => {
      out += `${i+1}. ${a.symbol} - Drop: ${a.drop.toFixed(2)}%\nBaseline: $${a.baseline}, Now: $${a.current}\nTime: ${a.time}\n\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/setbaseline") {
    if (!config.ADMINS.includes(userId)) {
      return await sendMessage(chatId, "❌ Admin only command.");
    }
    await setBaseline();
    await sendMessage(chatId, "✅ Baseline refreshed manually (admin).");
  } else if (text === "/clearhistory") {
    if (!config.ADMINS.includes(userId)) {
      return await sendMessage(chatId, "❌ Admin only command.");
    }
    triggeredAlerts = [];
    saveJSON(alertsFile, triggeredAlerts);
    await sendMessage(chatId, "🧹 Alerts history cleared.");
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Try /help");
  }

  res.sendStatus(200);
});

// --- Fetch Coins ---
async function fetchTopCoins() {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit: 20, convert: "USD" }
    });
    return res.data.data.map(c => ({
      symbol: c.symbol,
      price: parseFloat(c.quote.USD.price.toFixed(2)),
      change: parseFloat(c.quote.USD.percent_change_24h.toFixed(2))
    }));
  } catch (err) {
    console.error("❌ Fetch error:", err.response?.data || err.message);
    return null;
  }
}

// --- Baseline ---
async function setBaseline() {
  const coins = await fetchTopCoins();
  if (!coins) return;
  baseline = {
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    coins: coins.slice(0,10)
  };
  saveJSON(baselineFile, baseline);
  console.log("✅ Baseline set and saved");
}

// --- Alerts Monitor ---
async function checkAlerts() {
  if (!baseline) return;
  const current = await fetchTopCoins();
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
        `🚨 *ALERT*: ${c.symbol} dropped ${drop.toFixed(2)}%\nBaseline: $${c.price}\nNow: $${live.price}\n⏰ ${alert.time}`,
        true
      );
    }
  }
}

// --- Scheduler ---
async function dailyScheduler() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = now.getHours(), m = now.getMinutes();
  if (h === 6 && m === 0) {
    await setBaseline();
    await sendMessage(config.CHAT_ID, "✅ *Daily 6AM Baseline set*", true);
  }
  if (h === 22 && m === 0 && baseline) {
    const current = await fetchTopCoins();
    if (current) {
      let perf = baseline.coins.map(c => {
        const live = current.find(x => x.symbol === c.symbol);
        if (!live) return null;
        return {
          symbol: c.symbol,
          baseline: c.price,
          current: live.price,
          change: ((live.price - c.price) / c.price) * 100
        };
      }).filter(Boolean).sort((a,b) => b.change - a.change);

      let out = `*📊 Daily Summary (10PM IST)*\nBaseline set: ${baseline.time}\n\n`;
      perf.forEach((p,i) => {
        out += `${i+1}. ${p.symbol} - ${p.change.toFixed(2)}%\n`;
      });
      await sendMessage(config.CHAT_ID, out, true);
    }
  }
}

// --- Startup ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  await setWebhook();

  if (!baseline) {
    console.log("⚠️ No baseline found. Creating one now...");
    await setBaseline();
  }
  setInterval(checkAlerts, 60 * 1000);
  setInterval(dailyScheduler, 60 * 1000);
  console.log("🔍 Scanner initialized");
});
