/**
 * cryptoScanner.js
 * Telegram crypto scanner bot with baseline, alerts, top10, profit,
 * daily summary, log rotation, and webhook mode.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const schedule = require("node-schedule");

// ================== CONFIG FROM ENV ==================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const BASE_URL = process.env.BASE_URL || "http://localhost:10000";
const PORT = process.env.PORT || 10000;

const CMC_API_KEY = process.env.CMC_API_KEY;
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000"); // ms
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

// ================== FILES ==================
const DATA_FILE = path.join(__dirname, "data.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOG_DIR = path.join(__dirname, "logs");

// Ensure dirs exist
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// ================== LOGGING ==================
function log(message) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] ${message}`;
  console.log(line);

  const fname = `app-${new Date()
    .toISOString()
    .slice(0, 10)}.log`;
  fs.appendFileSync(path.join(LOG_DIR, fname), line + "\n");

  // Keep logs 7 days
  const files = fs.readdirSync(LOG_DIR);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  files.forEach((f) => {
    const d = new Date(f.slice(4, 14));
    if (d.getTime() < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
  });
}

// ================== LOAD / SAVE HELPERS ==================
function loadJSON(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return def;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let data = loadJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
let alerts = loadJSON(ALERTS_FILE, []);

// ================== TELEGRAM BOT ==================
if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_TOKEN not set");
  process.exit(1);
}
const bot = new Telegraf(TELEGRAM_TOKEN);

// Webhook mode
const app = express();
app.use(bot.webhookCallback("/webhook"));

bot.telegram.setWebhook(`${BASE_URL}/webhook`).then(() => {
  log(`✅ Webhook set to ${BASE_URL}/webhook`);
});

app.listen(PORT, () => {
  log(`🌍 Server listening on port ${PORT}`);
  log(
    `Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`
  );
});

// ================== COINMARKETCAP FETCH ==================
async function fetchTopCoins() {
  try {
    const res = await axios.get(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest`,
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
        params: { start: 1, limit: FETCH_LIMIT, convert: "USD" },
      }
    );
    return res.data.data.map((c) => ({
      symbol: c.symbol,
      name: c.name,
      price: c.quote.USD.price,
      percent24h: c.quote.USD.percent_change_24h,
      volume24h: c.quote.USD.volume_24h,
      marketCap: c.quote.USD.market_cap,
    }));
  } catch (err) {
    log("❌ Fetch error: " + err.message);
    return [];
  }
}

// ================== BASELINE ==================
async function setBaseline(dateOverride = null) {
  const coins = await fetchTopCoins();
  if (coins.length === 0) return false;

  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  data = {
    date: dateOverride || istNow.toISOString().slice(0, 10),
    setAt: istNow.toISOString(),
    coins: coins.map((c) => ({ ...c })),
  };
  saveJSON(DATA_FILE, data);
  alerts = [];
  saveJSON(ALERTS_FILE, alerts);

  log(`✅ Baseline set for ${data.date} at ${data.setAt}`);
  return true;
}

// ================== ALERT MONITOR ==================
async function monitor() {
  if (!data || !data.coins || data.coins.length === 0) return;
  const nowCoins = await fetchTopCoins();
  if (nowCoins.length === 0) return;

  for (let coin of nowCoins) {
    const base = data.coins.find((c) => c.symbol === coin.symbol);
    if (!base) continue;

    const change = ((coin.price - base.price) / base.price) * 100;
    if (change <= ALERT_DROP_PERCENT) {
      if (!alerts.find((a) => a.symbol === coin.symbol)) {
        alerts.push({ symbol: coin.symbol, at: new Date().toISOString() });
        saveJSON(ALERTS_FILE, alerts);

        bot.telegram.sendMessage(
          CHAT_ID,
          `🚨 Alert: ${coin.symbol} dropped ${change.toFixed(2)}% since baseline`
        );
      }
    }
  }
}

// ================== COMMANDS ==================
bot.start((ctx) => {
  ctx.reply(
    `👋 Welcome to Crypto Scanner\n\nCommands:\n/start\n/setbaseline [YYYY-MM-DD]\n/profit\n/top10\n/alerts\n/clearhistory (admin)\n/status\n/logs (admin)\n/help`
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    `/setbaseline [YYYY-MM-DD] - set baseline now or for past date\n/profit - compare all coins vs baseline\n/top10 - show top10 profitable coins (filters)\n/alerts - list fired alerts\n/status - current baseline info\n/clearhistory (admin) - reset alerts\n/logs (admin) - last 7 days logs`
  );
});

bot.command("setbaseline", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const dateArg = parts[1] || null;

  if (await setBaseline(dateArg)) {
    ctx.reply(`✅ Baseline set (manual) at ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\nDate: ${dateArg || data.date}`);
  } else {
    ctx.reply("❌ Failed to set baseline");
  }
});

bot.command("profit", async (ctx) => {
  if (!data.coins || data.coins.length === 0) return ctx.reply("⚠️ No baseline set.");
  const nowCoins = await fetchTopCoins();
  let msg = `📈 Profit since baseline (${data.date})\n`;
  data.coins.slice(0, 10).forEach((base, i) => {
    const now = nowCoins.find((c) => c.symbol === base.symbol);
    if (!now) return;
    const change = ((now.price - base.price) / base.price) * 100;
    msg += `${i + 1}. ${base.symbol} → ${change.toFixed(2)}% (from $${base.price.toFixed(2)} to $${now.price.toFixed(2)})\n`;
  });
  ctx.reply(msg);
});

bot.command("top10", async (ctx) => {
  if (!data.coins || data.coins.length === 0) return ctx.reply("⚠️ No baseline set.");
  const nowCoins = await fetchTopCoins();

  // Apply filters: 24h gain ≥ 20%, vol ≥ 50M, mcap ≥ 500M
  const filtered = nowCoins
    .filter(
      (c) =>
        c.percent24h >= 20 &&
        c.volume24h >= 50_000_000 &&
        c.marketCap >= 500_000_000
    )
    .sort((a, b) => b.percent24h - a.percent24h)
    .slice(0, 10);

  if (filtered.length === 0) return ctx.reply("⚠️ No coins match filters now.");

  let msg = "🔥 Top 10 potential gainers (next 24h):\n";
  filtered.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} (${c.name}) → ${c.percent24h.toFixed(2)}% (Vol $${(c.volume24h/1e6).toFixed(1)}M, MC $${(c.marketCap/1e9).toFixed(1)}B)\n`;
  });
  ctx.reply(msg);
});

bot.command("alerts", (ctx) => {
  if (alerts.length === 0) return ctx.reply("✅ No alerts fired yet.");
  let msg = "🚨 Alerts fired today:\n";
  alerts.forEach((a) => (msg += `- ${a.symbol} at ${a.at}\n`));
  ctx.reply(msg);
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  alerts = [];
  saveJSON(ALERTS_FILE, alerts);
  ctx.reply("✅ Alerts history cleared.");
});

bot.command("status", (ctx) => {
  if (!data.date) return ctx.reply("⚠️ No baseline set.");
  ctx.reply(`📊 Baseline date: ${data.date}\nSet at: ${data.setAt}\nCoins tracked: ${data.coins.length}`);
});

bot.command("logs", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const files = fs.readdirSync(LOG_DIR).slice(-7);
  ctx.reply("📜 Last 7 log files:\n" + files.join("\n"));
});

// ================== SCHEDULERS ==================
// Auto baseline at configured time
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  await setBaseline();
  bot.telegram.sendMessage(CHAT_ID, `✅ Daily baseline set automatically at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST`);
});

// Daily summary 10 PM IST
schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
  if (!data.coins || data.coins.length === 0) return;
  const nowCoins = await fetchTopCoins();
  let msg = "📊 Daily Summary:\n";
  data.coins.slice(0, 10).forEach((base, i) => {
    const now = nowCoins.find((c) => c.symbol === base.symbol);
    if (!now) return;
    const change = ((now.price - base.price) / base.price) * 100;
    msg += `${i + 1}. ${base.symbol} → ${change.toFixed(2)}%\n`;
  });
  bot.telegram.sendMessage(CHAT_ID, msg);
});

// Monitoring loop
setInterval(monitor, REFRESH_INTERVAL);