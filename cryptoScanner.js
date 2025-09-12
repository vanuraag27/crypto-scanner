const express = require("express");
const axios = require("axios");
const fs = require("fs");
const schedule = require("node-schedule");
const config = require("./config");

const app = express();
app.use(express.json());

// ---------------------- Chat Persistence ----------------------
const CHAT_FILE = "./chat.json";

function loadChatId() {
  if (fs.existsSync(CHAT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CHAT_FILE, "utf-8")).chatId || null;
    } catch {
      return null;
    }
  }
  return null;
}

function saveChatId(chatId) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify({ chatId }, null, 2));
}

let CHAT_ID = loadChatId();

// ---------------------- Baseline Persistence ----------------------
const BASELINE_FILE = "./baseline.json";
let baseline = { date: null, coins: [] };

function loadBaseline() {
  if (fs.existsSync(BASELINE_FILE)) {
    try {
      baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    } catch {
      baseline = { date: null, coins: [] };
    }
  }
}
function saveBaseline() {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

loadBaseline();

// ---------------------- Telegram Helpers ----------------------
async function sendMessage(chatId, text, markdown = false) {
  if (!chatId) {
    console.log("⚠️ No chatId available. Skipping sendMessage.");
    return;
  }
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

// ---------------------- Market Data ----------------------
async function fetchTopCoins(limit = 20) {
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

// ---------------------- Baseline Logic ----------------------
async function setBaseline() {
  const coins = await fetchTopCoins(20);
  baseline = {
    date: new Date().toISOString(),
    coins: coins.slice(0, 10)
  };
  saveBaseline();

  let out = `✅ *Baseline set (${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})*\nMonitoring top 10:\n`;
  baseline.coins.forEach((c, i) => {
    out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
  });

  if (CHAT_ID) await sendMessage(CHAT_ID, out, true);
}

// ---------------------- Scheduler ----------------------
// Auto baseline at 6 AM IST
schedule.scheduleJob("0 6 * * *", { tz: "Asia/Kolkata" }, async () => {
  if (!baseline.date || new Date(baseline.date).toDateString() !== new Date().toDateString()) {
    console.log("🌅 6 AM baseline task running...");
    await setBaseline();
  } else {
    console.log("✅ Baseline already set today. Skipping auto baseline.");
  }
});

// ---------------------- Telegram Webhook ----------------------
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start") {
    CHAT_ID = chatId;
    saveChatId(chatId);
    await sendMessage(chatId, "👋 Welcome! You will now receive crypto scanner updates here.");
  } else if (text === "/top10") {
    if (!baseline.coins.length) {
      await setBaseline();
    }
    let out = `📊 *Top 10 Baseline (${new Date(baseline.date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})*\n`;
    baseline.coins.forEach((c, i) => {
      out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)}\n`;
    });
    await sendMessage(chatId, out, true);
  } else if (text === "/profit") {
    if (!baseline.coins.length) {
      await sendMessage(chatId, "⚠️ Baseline not set yet.");
    } else {
      const current = await fetchTopCoins(50);
      let list = baseline.coins.map(c => {
        const cur = current.find(x => x.symbol === c.symbol);
        if (!cur) return null;
        return {
          symbol: c.symbol,
          baseline: c.price,
          current: cur.price,
          profit: ((cur.price - c.price) / c.price) * 100
        };
      }).filter(Boolean);

      list.sort((a, b) => b.profit - a.profit);
      let out = `💹 *Profit since baseline (${new Date(baseline.date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})*\n`;
      list.forEach((c, i) => {
        out += `${i + 1}. ${c.symbol}: ${c.profit.toFixed(2)}% | $${c.current.toFixed(2)} (baseline: $${c.baseline.toFixed(2)})\n`;
      });
      await sendMessage(chatId, out, true);
    }
  } else {
    await sendMessage(chatId, "⚠️ Unknown command. Try /top10 or /profit.");
  }

  res.sendStatus(200);
});

// ---------------------- Server Start ----------------------
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
});
