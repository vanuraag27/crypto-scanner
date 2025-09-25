// cryptoScanner.js
// Telegram Crypto Scanner Bot with Webhook + Baseline + Alerts + Logging
// Filters loosened (Option B): Gain ≥ 1%, Volume ≥ $1M, Market Cap ≥ $10M

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const schedule = require("node-schedule");
const { Telegraf } = require("telegraf");

// === ENVIRONMENT CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000", 10);
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0", 10);
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50", 10);
const CMC_API_KEY = process.env.CMC_API_KEY;

// === FILE PATHS ===
const persistenceFile = path.join(__dirname, "data.json");
const alertsFile = path.join(__dirname, "alerts.json");
const logsDir = path.join(__dirname, "logs");

// === STATE ===
let state = { date: null, setAt: null, coins: [] };
let alerts = { date: null, symbols: [] };

// === HELPERS ===
function log(msg) {
  const now = new Date();
  const line = `[${now.toLocaleString()}] ${msg}`;
  console.log(line);

  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
  const file = path.join(logsDir, `${now.toISOString().split("T")[0]}.log`);
  fs.appendFileSync(file, line + "\n");
}

function loadPersistence() {
  if (fs.existsSync(persistenceFile)) {
    try {
      state = JSON.parse(fs.readFileSync(persistenceFile, "utf8"));
    } catch {
      state = { date: null, setAt: null, coins: [] };
    }
  }
  if (fs.existsSync(alertsFile)) {
    try {
      alerts = JSON.parse(fs.readFileSync(alertsFile, "utf8"));
    } catch {
      alerts = { date: null, symbols: [] };
    }
  }
  log("Loaded persistence: " + JSON.stringify(state, null, 2));
}

function savePersistence() {
  fs.writeFileSync(persistenceFile, JSON.stringify(state, null, 2));
}

function saveAlerts() {
  fs.writeFileSync(alertsFile, JSON.stringify(alerts, null, 2));
}

async function fetchTopCoins(limit = FETCH_LIMIT) {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${limit}&convert=USD`;
  const res = await axios.get(url, {
    headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
  });
  return res.data.data;
}

function filterCoins(data) {
  // Option B filters
  return data.filter(
    (c) =>
      c.quote.USD.percent_change_24h >= 1 &&
      c.quote.USD.volume_24h >= 10_000_00 &&
      c.quote.USD.market_cap >= 100_000_00
  );
}

function formatCoin(c) {
  return `${c.symbol} — $${c.quote.USD.price.toFixed(4)} (24h: ${c.quote.USD.percent_change_24h.toFixed(2)}%)`;
}

// === TELEGRAM BOT ===
const bot = new Telegraf(TELEGRAM_TOKEN);

// /start
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome to Crypto Scanner Bot!\n\n📌 Commands:\n" +
      "/start - register this chat\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show filtered top 10 (baseline)\n" +
      "/profit - profit since baseline\n" +
      "/alerts - list triggered alerts\n" +
      "/setbaseline - admin only, set baseline now\n" +
      "/clearhistory - admin only, reset alerts\n" +
      "/logs - admin only, fetch last 7 days logs"
  );
});

// /status
bot.command("status", (ctx) => {
  ctx.reply(
    `📊 Baseline date: ${state.date || "N/A"}\nSet at: ${state.setAt || "N/A"}\nCoins tracked: ${state.coins.length}`
  );
});

// /top10
bot.command("top10", async (ctx) => {
  if (!state.date || !state.coins.length) {
    return ctx.reply("⚠️ Baseline not set yet.");
  }
  const coins = state.coins.slice(0, 10);
  if (!coins.length) return ctx.reply("⚠️ No coins match filters now.");
  const msg =
    `📊 Baseline Top 10 (day: ${state.date}, set at ${new Date(state.setAt).toLocaleString()})\n` +
    coins.map((c, i) => `${i + 1}. ${formatCoin(c)}`).join("\n");
  ctx.reply(msg);
});

// /profit
bot.command("profit", async (ctx) => {
  if (!state.date || !state.coins.length) {
    return ctx.reply("⚠️ Baseline not set yet.");
  }
  try {
    const data = await fetchTopCoins(FETCH_LIMIT);
    const tracked = state.coins.map((base) => {
      const cur = data.find((c) => c.symbol === base.symbol);
      if (!cur) return null;
      const pct = ((cur.quote.USD.price - base.quote.USD.price) / base.quote.USD.price) * 100;
      return {
        symbol: base.symbol,
        from: base.quote.USD.price,
        to: cur.quote.USD.price,
        pct,
      };
    }).filter(Boolean);

    tracked.sort((a, b) => b.pct - a.pct);

    const msg =
      `📈 Profit since baseline (${state.date})\n` +
      tracked
        .slice(0, 10)
        .map(
          (c, i) =>
            `${i + 1}. ${c.symbol} → ${c.pct.toFixed(2)}% (from $${c.from.toFixed(4)} to $${c.to.toFixed(4)})`
        )
        .join("\n");
    ctx.reply(msg);
  } catch (err) {
    ctx.reply("❌ Error fetching profit data.");
    log("Profit error: " + err.message);
  }
});

// /alerts
bot.command("alerts", (ctx) => {
  if (!alerts.date || !alerts.symbols.length) {
    return ctx.reply(`🔔 Alerts for baseline ${state.date || "N/A"}: None`);
  }
  ctx.reply(
    `🔔 Alerts for baseline ${alerts.date}:\n` +
      alerts.symbols.map((a) => `${a.symbol} dropped ${a.drop.toFixed(2)}%`).join("\n")
  );
});

// /setbaseline (admin only)
bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("⛔ Admin only.");
  }
  try {
    const data = await fetchTopCoins(FETCH_LIMIT);
    const filtered = filterCoins(data);
    state = {
      date: new Date().toISOString().split("T")[0],
      setAt: new Date().toISOString(),
      coins: filtered,
    };
    savePersistence();
    alerts = { date: state.date, symbols: [] };
    saveAlerts();

    ctx.reply(
      `✅ Baseline set (manual) at ${new Date(state.setAt).toLocaleString()}\nDate: ${state.date}\n` +
        (filtered.length
          ? filtered
              .slice(0, 10)
              .map((c, i) => `${i + 1}. ${formatCoin(c)}`)
              .join("\n")
          : "⚠️ No coins matched filters at baseline.")
    );
  } catch (err) {
    ctx.reply("❌ Error setting baseline.");
    log("Baseline error: " + err.message);
  }
});

// /clearhistory (admin only)
bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("⛔ Admin only.");
  }
  alerts = { date: state.date, symbols: [] };
  saveAlerts();
  ctx.reply("✅ Alerts cleared for current baseline day.");
});

// /logs (admin only)
bot.command("logs", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .slice(-7); // last 7 days
  if (!files.length) return ctx.reply("⚠️ No logs found.");
  ctx.reply("📂 Logs:\n" + files.join("\n"));
});

// === SCHEDULER ===
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  log("⏰ Scheduled baseline run triggered.");
  try {
    const data = await fetchTopCoins(FETCH_LIMIT);
    const filtered = filterCoins(data);
    state = {
      date: new Date().toISOString().split("T")[0],
      setAt: new Date().toISOString(),
      coins: filtered,
    };
    savePersistence();
    alerts = { date: state.date, symbols: [] };
    saveAlerts();

    const msg =
      `✅ Baseline set (auto) at ${new Date(state.setAt).toLocaleString()}\nDate: ${state.date}\n` +
      (filtered.length
        ? filtered
            .slice(0, 10)
            .map((c, i) => `${i + 1}. ${formatCoin(c)}`)
            .join("\n")
        : "⚠️ No coins matched filters at baseline.");
    await bot.telegram.sendMessage(CHAT_ID, msg);
  } catch (err) {
    log("Auto baseline error: " + err.message);
  }
});

// Alert checker (runs every REFRESH_INTERVAL)
setInterval(async () => {
  if (!state.date || !state.coins.length) return;
  try {
    const data = await fetchTopCoins(FETCH_LIMIT);
    for (let base of state.coins) {
      const cur = data.find((c) => c.symbol === base.symbol);
      if (!cur) continue;
      const pct = ((cur.quote.USD.price - base.quote.USD.price) / base.quote.USD.price) * 100;
      if (pct <= ALERT_DROP_PERCENT) {
        if (!alerts.symbols.some((a) => a.symbol === base.symbol)) {
          alerts.symbols.push({ symbol: base.symbol, drop: pct });
          saveAlerts();
          await bot.telegram.sendMessage(
            CHAT_ID,
            `🚨 ALERT: ${base.symbol} dropped ${pct.toFixed(2)}%\nBaseline: $${base.quote.USD.price.toFixed(
              4
            )}\nNow: $${cur.quote.USD.price.toFixed(4)}\nTime: ${new Date().toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}`
          );
        }
      }
    }
  } catch (err) {
    log("Alert check error: " + err.message);
  }
}, REFRESH_INTERVAL);

// === EXPRESS SERVER (Webhook) ===
const app = express();
app.use(bot.webhookCallback("/webhook"));

(async () => {
  await bot.telegram.setWebhook(`${BASE_URL}/webhook`);
  log(`✅ Webhook set to ${BASE_URL}/webhook`);

  loadPersistence();
  app.listen(10000, () => {
    log("🌍 Server listening on port 10000");
    log(
      `Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`
    );
    if (!state.date) {
      log(`⚠️ Official baseline not set for today. Will auto-set at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin can run /setbaseline.`);
    }
  });
})();