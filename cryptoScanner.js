const fs = require("fs");
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");

const app = express();
const PORT = process.env.PORT || 10000;

let baseline = null;
let alertsFired = new Set();

// === Load Baseline at Startup ===
function loadBaseline() {
  if (fs.existsSync("baseline.json")) {
    try {
      const data = JSON.parse(fs.readFileSync("baseline.json"));
      if (data && data.timestamp && Array.isArray(data.coins)) {
        baseline = data;
        console.log(
          "✅ Loaded baseline from file:",
          new Date(baseline.timestamp).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })
        );
        return;
      }
    } catch (err) {
      console.error("⚠️ Error reading baseline.json:", err.message);
    }
  }
  baseline = null;
}

function saveBaseline() {
  fs.writeFileSync("baseline.json", JSON.stringify(baseline, null, 2));
  console.log("💾 Baseline saved.");
}

// === Fetch Top Coins ===
async function fetchTopCoins() {
  try {
    const res = await axios.get(config.API_URL);
    return res.data
      .slice(0, 10)
      .map((c) => ({
        symbol: c.symbol.toUpperCase(),
        price: c.current_price,
        change: c.price_change_percentage_24h,
      }));
  } catch (err) {
    console.error("❌ API error:", err.message);
    return [];
  }
}

// === Baseline Setter ===
async function setBaseline(manual = false) {
  const coins = await fetchTopCoins();
  if (coins.length === 0) return;

  baseline = { timestamp: Date.now(), coins };
  alertsFired.clear();
  saveBaseline();

  const msg =
    (manual
      ? "✅ Baseline created manually."
      : "✅ Baseline set (6 AM IST)") +
    `\nMonitoring top 10:\n` +
    coins
      .map(
        (c, i) =>
          `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`
      )
      .join("\n");

  bot.sendMessage(config.CHAT_ID, msg);
}

// === Commands ===
function sendTop10(chatId) {
  const ts = new Date(baseline.timestamp).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
  const out =
    `📊 Top 10 Baseline (${ts})\n` +
    baseline.coins
      .map(
        (c, i) =>
          `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)`
      )
      .join("\n");
  bot.sendMessage(chatId, out);
}

async function sendProfit(chatId) {
  const now = await fetchTopCoins();
  const ts = new Date(baseline.timestamp).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const perf = baseline.coins.map((b) => {
    const cur = now.find((c) => c.symbol === b.symbol);
    if (!cur) return null;
    const pct = ((cur.price - b.price) / b.price) * 100;
    return { ...cur, baseline: b.price, pct };
  }).filter(Boolean);

  perf.sort((a, b) => b.pct - a.pct);

  const out =
    `📈 Profit since ${ts}\n` +
    perf
      .map(
        (c, i) =>
          `${i + 1}. ${c.symbol} | Δ ${c.pct.toFixed(2)}% | $${c.baseline.toFixed(
            2
          )} → $${c.price.toFixed(2)}`
      )
      .join("\n");

  bot.sendMessage(chatId, out);
}

function sendStatus(chatId) {
  if (!baseline) {
    bot.sendMessage(chatId, "⚠️ No baseline set yet.");
    return;
  }
  const ts = new Date(baseline.timestamp).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
  bot.sendMessage(chatId, `✅ Scanner running.\nBaseline: ${ts}`);
}

function sendAlerts(chatId) {
  if (alertsFired.size === 0) {
    bot.sendMessage(chatId, "🚨 Alerts fired: None");
  } else {
    bot.sendMessage(chatId, "🚨 Alerts fired: " + Array.from(alertsFired).join(", "));
  }
}

// === Alerts Check ===
async function checkAlerts() {
  if (!baseline) return;
  const now = await fetchTopCoins();

  baseline.coins.forEach((b) => {
    const cur = now.find((c) => c.symbol === b.symbol);
    if (!cur) return;
    const drop = ((cur.price - b.price) / b.price) * 100;

    if (drop <= -10 && !alertsFired.has(b.symbol)) {
      alertsFired.add(b.symbol);
      const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const msg = `⚠️ ALERT: ${b.symbol} dropped ${drop.toFixed(
        2
      )}%\nBaseline: $${b.price.toFixed(2)}\nNow: $${cur.price.toFixed(
        2
      )}\nTime: ${ts}`;
      bot.sendMessage(config.CHAT_ID, msg);
    }
  });
}

// === Telegram Bot ===
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🤖 Welcome! Available commands:\n/top10\n/profit\n/status\n/alerts\n/help"
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "📌 Commands:\n/top10 → Show baseline list\n/profit → Show % changes since baseline\n/status → Show scanner status\n/alerts → List triggered alerts\n/setbaseline → Admin only\n/clearhistory → Admin only"
  );
});

bot.onText(/\/top10/, (msg) => {
  if (!baseline) return bot.sendMessage(msg.chat.id, "⚠️ No baseline yet.");
  sendTop10(msg.chat.id);
});

bot.onText(/\/profit/, (msg) => {
  if (!baseline) return bot.sendMessage(msg.chat.id, "⚠️ No baseline yet.");
  sendProfit(msg.chat.id);
});

bot.onText(/\/status/, (msg) => sendStatus(msg.chat.id));
bot.onText(/\/alerts/, (msg) => sendAlerts(msg.chat.id));

bot.onText(/\/setbaseline/, (msg) => {
  if (msg.chat.id.toString() !== config.ADMIN_ID.toString()) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  setBaseline(true);
});

bot.onText(/\/clearhistory/, (msg) => {
  if (msg.chat.id.toString() !== config.ADMIN_ID.toString()) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }
  alertsFired.clear();
  bot.sendMessage(msg.chat.id, "🧹 Alert history cleared.");
});

// === Scheduler: 6 AM IST baseline reset ===
cron.schedule(
  "0 6 * * *",
  () => {
    console.log("⏰ Daily 6 AM baseline reset");
    setBaseline(false);
  },
  { timezone: "Asia/Kolkata" }
);

// === Alerts check every 1 min ===
setInterval(checkAlerts, 60 * 1000);

// === Server for Render ===
app.get("/", (req, res) => res.send("Crypto Scanner Running"));
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));

// === Init ===
loadBaseline();
if (!baseline) {
  console.log("⚠️ No baseline found. Will wait until 6 AM or admin /setbaseline.");
} else {
  console.log("🔍 Scanner initialized with existing baseline.");
}
