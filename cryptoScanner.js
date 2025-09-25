/**
 * cryptoScanner.js
 * Telegram crypto scanner with baseline, profit tracking, alerts, and auto-profit toggle.
 */

const express = require("express");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const schedule = require("node-schedule");
const axios = require("axios");
const moment = require("moment-timezone");

// ============ ENV CONFIG ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");

const DATA_FILE = "data.json";
const ALERTS_FILE = "alerts.json";
const LOG_DIR = "logs";

// ============ STATE ============
let baseline = { date: null, setAt: null, coins: [] };
let alertsTriggered = [];
let profitInterval = null; // for auto-profit toggle

// ============ UTILS ============
function log(msg) {
  const now = moment().tz("Asia/Kolkata").format("DD/MM/YYYY, h:mm:ss a");
  const line = `[${now}] ${msg}`;
  console.log(line);

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
  const logFile = `${LOG_DIR}/${moment().tz("Asia/Kolkata").format("YYYY-MM-DD")}.log`;
  fs.appendFileSync(logFile, line + "\n");

  // Cleanup old logs (7 days retention)
  const files = fs.readdirSync(LOG_DIR);
  const cutoff = moment().subtract(7, "days");
  files.forEach((file) => {
    const dateStr = file.replace(".log", "");
    if (moment(dateStr, "YYYY-MM-DD").isBefore(cutoff)) {
      fs.unlinkSync(`${LOG_DIR}/${file}`);
    }
  });
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      baseline = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch {
      baseline = { date: null, setAt: null, coins: [] };
    }
  }
  if (fs.existsSync(ALERTS_FILE)) {
    try {
      alertsTriggered = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    } catch {
      alertsTriggered = [];
    }
  }
  log("Loaded persistence: " + JSON.stringify(baseline, null, 2));
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(baseline, null, 2));
}

function saveAlerts() {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertsTriggered, null, 2));
}

function formatCoins(coins) {
  return coins
    .map(
      (c, i) =>
        `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(
          2
        )}%)`
    )
    .join("\n");
}

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
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h,
      volume: c.quote.USD.volume_24h,
      marketCap: c.quote.USD.market_cap,
    }));
  } catch (err) {
    log("Error fetching coins: " + err.message);
    return [];
  }
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));

(async () => {
  await bot.telegram.setWebhook(`${BASE_URL}/webhook`);
  log(`✅ Webhook set to ${BASE_URL}/webhook`);
})();

app.listen(10000, () => {
  log("🌍 Server listening on port 10000");
});

// ============ COMMANDS ============
bot.start((ctx) => {
  if (ctx.chat.id.toString() !== CHAT_ID) return;
  log(`Saved chatId from /start: ${ctx.chat.id}`);
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/start - register chat\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show baseline coins\n" +
      "/profit - show profit since baseline\n" +
      "/alerts - list alerts\n" +
      "/setbaseline [YYYY-MM-DD] - admin set baseline\n" +
      "/clearhistory - admin clear alerts\n" +
      "/autoprofit on|off - toggle auto-profit updates"
  );
});

bot.command("status", (ctx) => {
  ctx.reply(
    `📊 Baseline date: ${baseline.date || "N/A"}\nSet at: ${
      baseline.setAt || "N/A"
    }\nCoins tracked: ${baseline.coins.length}`
  );
});

bot.command("top10", (ctx) => {
  if (!baseline.date || !baseline.coins.length)
    return ctx.reply("⚠️ No baseline set yet.");
  ctx.reply(
    `📊 Baseline Top 10 (day: ${baseline.date})\n${formatCoins(
      baseline.coins
    )}`
  );
});

bot.command("profit", async (ctx) => {
  if (!baseline.date || !baseline.coins.length)
    return ctx.reply("⚠️ No baseline set yet.");
  const latest = await fetchTopCoins();
  const report = baseline.coins
    .map((b) => {
      const c = latest.find((x) => x.symbol === b.symbol);
      if (!c) return null;
      const change = ((c.price - b.price) / b.price) * 100;
      return {
        symbol: b.symbol,
        change,
        from: b.price,
        to: c.price,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.change - a.change);

  let msg = `📈 Profit since baseline (${baseline.date})\n`;
  report.forEach((r, i) => {
    msg += `${i + 1}. ${r.symbol} → ${r.change.toFixed(
      2
    )}% (from $${r.from.toFixed(2)} to $${r.to.toFixed(2)})\n`;
  });
  ctx.reply(msg);
});

bot.command("alerts", (ctx) => {
  ctx.reply(
    `🔔 Alerts for baseline ${baseline.date || "N/A"}:\n${
      alertsTriggered.length ? alertsTriggered.join(", ") : "None"
    }`
  );
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("❌ Admin only command.");
  const args = ctx.message.text.split(" ");
  let dateStr = null;
  if (args[1]) dateStr = args[1].replace(/[\[\]]/g, "");
  const coins = await fetchTopCoins();
  baseline = {
    date: dateStr || moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
    setAt: new Date().toISOString(),
    coins: coins.slice(0, 10),
  };
  saveData();
  alertsTriggered = [];
  saveAlerts();
  ctx.reply(
    `✅ Baseline set (manual) at ${moment()
      .tz("Asia/Kolkata")
      .format("D/M/YYYY, h:mm:ss a")}\nDate: ${baseline.date}\n${formatCoins(
      baseline.coins
    )}`
  );
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("❌ Admin only command.");
  alertsTriggered = [];
  saveAlerts();
  ctx.reply("🧹 Alerts cleared for current baseline.");
});

bot.command("autoprofit", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID)
    return ctx.reply("❌ Admin only command.");
  const args = ctx.message.text.split(" ");
  const option = args[1] ? args[1].toLowerCase() : null;
  if (option === "on") {
    if (profitInterval) clearInterval(profitInterval);
    profitInterval = setInterval(() => {
      ctx.reply("⏱ Auto-profit update:");
      bot.telegram.sendMessage(CHAT_ID, "/profit");
    }, 5 * 60 * 1000);
    return ctx.reply("✅ Auto-profit updates enabled (every 5 minutes).");
  }
  if (option === "off") {
    if (profitInterval) clearInterval(profitInterval);
    profitInterval = null;
    return ctx.reply("🛑 Auto-profit updates disabled.");
  }
  ctx.reply("Usage: /autoprofit on | off");
});

// ============ SCHEDULERS ============
schedule.scheduleJob(
  { hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" },
  async () => {
    const coins = await fetchTopCoins();
    baseline = {
      date: moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
      setAt: new Date().toISOString(),
      coins: coins.slice(0, 10),
    };
    saveData();
    alertsTriggered = [];
    saveAlerts();
    bot.telegram.sendMessage(
      CHAT_ID,
      `✅ Baseline set (auto) at ${moment()
        .tz("Asia/Kolkata")
        .format("D/M/YYYY, h:mm:ss a")}\nDate: ${baseline.date}\n${formatCoins(
        baseline.coins
      )}`
    );
  }
);

// ============ INIT ============
loadData();
log(
  `Configuration: BASELINE ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | REFRESH_INTERVAL ${REFRESH_INTERVAL}ms | ALERT_DROP_PERCENT ${ALERT_DROP_PERCENT}%`
);
if (!baseline.date) {
  log(
    `⚠️ Official baseline not set for today. Will auto-set at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin can run /setbaseline.`
  );
}