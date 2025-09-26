import express from "express";
import fs from "fs-extra";
import axios from "axios";
import moment from "moment-timezone";
import schedule from "node-schedule";
import { Telegraf } from "telegraf";

// --- ENV ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;

const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");

// Filters
const MIN_GAIN = parseFloat(process.env.MIN_GAIN || "20");
const MIN_VOLUME = parseFloat(process.env.MIN_VOLUME || "50000000");
const MIN_MARKETCAP = parseFloat(process.env.MIN_MARKETCAP || "500000000");

// Persistence
const DATA_FILE = "data.json";
const ALERTS_FILE = "alerts.json";
const LOG_DIR = "logs";

let baseline = fs.readJsonSync(DATA_FILE, { throws: false }) || {
  date: null,
  setAt: null,
  coins: [],
};
let alerts = fs.readJsonSync(ALERTS_FILE, { throws: false }) || {
  baselineDate: null,
  alerts: [],
};

let autoProfitInterval = null;

// --- Logging ---
function log(message) {
  const ts = moment().tz("Asia/Kolkata").format("D/M/YYYY, h:mm:ss a");
  console.log(`[${ts}] ${message}`);

  fs.ensureDirSync(LOG_DIR);
  const filename = `${LOG_DIR}/log-${moment().format("YYYY-MM-DD")}.txt`;
  fs.appendFileSync(filename, `[${ts}] ${message}\n`);

  // Cleanup logs older than 7 days
  fs.readdirSync(LOG_DIR).forEach((f) => {
    const fileDate = f.replace("log-", "").replace(".txt", "");
    if (moment(fileDate, "YYYY-MM-DD").isBefore(moment().subtract(7, "days"))) {
      fs.removeSync(`${LOG_DIR}/${f}`);
    }
  });
}

// --- Telegram Bot ---
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);
app.listen(10000, () => log("🌍 Server listening on port 10000"));

// --- Helpers ---
function filterCoins(coins) {
  return coins.filter((c) => {
    const gain = parseFloat(c.quote.USD.percent_change_24h || 0);
    const volume = parseFloat(c.quote.USD.volume_24h || 0);
    const marketCap = parseFloat(c.quote.USD.market_cap || 0);
    return gain >= MIN_GAIN && volume >= MIN_VOLUME && marketCap >= MIN_MARKETCAP;
  });
}

async function fetchTopCoins(limit = 100) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
    });
    return res.data.data || [];
  } catch (err) {
    log("❌ Error fetching coins: " + err.message);
    return [];
  }
}

// --- Baseline ---
async function setBaseline(manual = false, customDate = null) {
  const coins = await fetchTopCoins();
  const filtered = filterCoins(coins).slice(0, 10);

  baseline = {
    date: customDate || moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
    setAt: moment().tz("Asia/Kolkata").toISOString(),
    coins: filtered.map((c) => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      percent: c.quote.USD.percent_change_24h,
    })),
  };

  alerts = { baselineDate: baseline.date, alerts: [] };
  fs.writeJsonSync(DATA_FILE, baseline, { spaces: 2 });
  fs.writeJsonSync(ALERTS_FILE, alerts, { spaces: 2 });

  let text = `${manual ? "✅ Baseline set (manual)" : "✅ Baseline set (auto)"} at ${moment(baseline.setAt)
    .tz("Asia/Kolkata")
    .format("D/M/YYYY, h:mm:ss a")}\nDate: [${baseline.date}]`;

  if (baseline.coins.length === 0) {
    text += `\n⚠️ No coins match filters now.`;
  } else {
    baseline.coins.forEach((c, i) => {
      text += `\n${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.percent.toFixed(2)}%)`;
    });
  }
  await bot.telegram.sendMessage(CHAT_ID, text);
}

// --- Profit Report ---
async function profitReport() {
  if (!baseline.date) return "⚠️ Baseline not set.";
  const coins = await fetchTopCoins();

  let text = `📈 Profit since baseline ([${baseline.date}])`;
  const results = [];

  for (let b of baseline.coins) {
    const current = coins.find((c) => c.symbol === b.symbol);
    if (current) {
      const change = ((current.quote.USD.price - b.price) / b.price) * 100;
      results.push({
        symbol: b.symbol,
        change,
        from: b.price,
        to: current.quote.USD.price,
      });
    }
  }

  results.sort((a, b) => b.change - a.change);
  results.forEach((r, i) => {
    text += `\n${i + 1}. ${r.symbol} → ${r.change.toFixed(2)}% (from $${r.from.toFixed(2)} to $${r.to.toFixed(2)})`;
  });
  return text;
}

// --- Alerts ---
async function checkAlerts() {
  if (!baseline.date) return;
  const coins = await fetchTopCoins();
  for (let b of baseline.coins) {
    const current = coins.find((c) => c.symbol === b.symbol);
    if (current) {
      const change = ((current.quote.USD.price - b.price) / b.price) * 100;
      if (change <= ALERT_DROP_PERCENT && !alerts.alerts.includes(b.symbol)) {
        alerts.alerts.push(b.symbol);
        fs.writeJsonSync(ALERTS_FILE, alerts, { spaces: 2 });
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🚨 Alert: ${b.symbol} dropped ${change.toFixed(2)}% since baseline!\nBaseline: $${b.price.toFixed(
            2
          )} → Now: $${current.quote.USD.price.toFixed(2)}`
        );
      }
    }
  }
}

// --- Commands ---
bot.start(async (ctx) => {
  await ctx.reply(
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

bot.command("status", async (ctx) => {
  let text = `📊 Baseline date: [${baseline.date || "N/A"}]\nSet at: ${baseline.setAt || "N/A"}\nCoins tracked: ${
    baseline.coins.length
  }\nFilters: Gain ≥ ${MIN_GAIN}%, Volume ≥ $${MIN_VOLUME / 1e6}M, Market Cap ≥ $${MIN_MARKETCAP / 1e6}M`;
  await ctx.reply(text);
});

bot.command("top10", async (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ No baseline set yet.");
  if (baseline.coins.length === 0) return ctx.reply("⚠️ No coins match filters now.");
  let text = `📊 Baseline Top 10 (day: ${baseline.date})`;
  baseline.coins.forEach((c, i) => {
    text += `\n${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.percent.toFixed(2)}%)`;
  });
  await ctx.reply(text);
});

bot.command("profit", async (ctx) => {
  await ctx.reply(await profitReport());
});

bot.command("alerts", async (ctx) => {
  if (!baseline.date) return ctx.reply("⚠️ No baseline set yet.");
  if (alerts.alerts.length === 0) return ctx.reply(`🔔 No alerts for baseline ${baseline.date}`);
  await ctx.reply(`🔔 Alerts for baseline ${baseline.date}: ${alerts.alerts.join(", ")}`);
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const args = ctx.message.text.split(" ");
  const customDate = args[1] || null;
  await setBaseline(true, customDate);
});

bot.command("clearhistory", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  alerts = { baselineDate: baseline.date, alerts: [] };
  fs.writeJsonSync(ALERTS_FILE, alerts, { spaces: 2 });
  await ctx.reply("🧹 Alerts history cleared.");
});

bot.command("autoprofit", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const arg = ctx.message.text.split(" ")[1];
  if (arg === "on") {
    if (autoProfitInterval) clearInterval(autoProfitInterval);
    autoProfitInterval = setInterval(async () => {
      const report = await profitReport();
      await bot.telegram.sendMessage(CHAT_ID, `⏱ Auto-profit update:\n\n${report}`);
    }, 5 * 60 * 1000);
    await ctx.reply("✅ Auto-profit updates enabled (every 5 minutes).");
  } else if (arg === "off") {
    clearInterval(autoProfitInterval);
    autoProfitInterval = null;
    await ctx.reply("⏱ Auto-profit updates disabled.");
  } else {
    await ctx.reply("Usage: /autoprofit on|off");
  }
});

// --- Scheduler ---
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, () => {
  setBaseline(false);
});
setInterval(checkAlerts, REFRESH_INTERVAL);

log(
  `Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`
);
if (!baseline.date) log("⚠️ Official baseline not set yet. Will auto-set at baseline time or admin can run /setbaseline.");