// cryptoScanner.js
import express from "express";
import { Telegraf } from "telegraf";
import axios from "axios";
import fs from "fs";
import moment from "moment-timezone";
import schedule from "node-schedule";

// ===== CONFIG FROM ENV =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;

const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000"); // 10 min
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

const MIN_GAIN = 20;
const MIN_VOLUME = 50_000_000;
const MIN_MARKETCAP = 500_000_000;

// ===== STATE =====
let baseline = null;
let autoProfitOn = false;
let autoProfitJob = null;

// ===== LOGGING =====
const logDir = "./logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function logFileName() {
  return `${logDir}/scanner-${moment().tz("Asia/Kolkata").format("YYYY-MM-DD")}.log`;
}

function log(msg) {
  const line = `[${moment().tz("Asia/Kolkata").format("DD/MM/YYYY, h:mm:ss a")}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFileName(), line + "\n");
}

function rotateLogs() {
  const files = fs.readdirSync(logDir).sort();
  if (files.length > 7) {
    for (let i = 0; i < files.length - 7; i++) {
      fs.unlinkSync(`${logDir}/${files[i]}`);
    }
  }
}
rotateLogs();

// ===== TELEGRAM BOT =====
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();

app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

app.listen(10000, () => {
  log(`🌍 Server listening on port 10000`);
  log(`✅ Webhook set to ${BASE_URL}/webhook`);
});

// ===== HELPER FUNCTIONS =====
async function fetchTopCoins(limit = 100) {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
        params: { start: 1, limit, convert: "USD,INR" },
      }
    );
    return res.data.data || [];
  } catch (err) {
    log("❌ Error fetching coins: " + err.message);
    return [];
  }
}

async function fetchHistorical(symbol) {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/historical",
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
        params: {
          symbol,
          time_start: moment().subtract(20, "days").toISOString(),
          time_end: moment().toISOString(),
          interval: "daily",
          convert: "USD",
        },
      }
    );
    return res.data.data.quotes || [];
  } catch (err) {
    log(`❌ Error fetching historical for ${symbol}: ${err.message}`);
    return [];
  }
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

async function filterCoins(coins) {
  const filtered = [];

  for (let c of coins) {
    const gain = parseFloat(c.quote.USD.percent_change_24h || 0);
    const volume = parseFloat(c.quote.USD.volume_24h || 0);
    const marketCap = parseFloat(c.quote.USD.market_cap || 0);

    if (gain < MIN_GAIN || volume < MIN_VOLUME || marketCap < MIN_MARKETCAP) continue;

    const hist = await fetchHistorical(c.symbol);
    if (hist.length < 15) continue;

    const closes = hist.map((h) => h.quote.USD.close);
    const volumes = hist.map((h) => h.quote.USD.volume);

    const todayRSI = calcRSI(closes);
    const yesterdayRSI = calcRSI(closes.slice(0, -1));

    const todayVol = volumes[volumes.length - 1];
    const yestVol = volumes[volumes.length - 2];

    if (todayRSI && yesterdayRSI && todayRSI > yesterdayRSI && todayVol > yestVol) {
      filtered.push(c);
    }
  }

  return filtered;
}

// ===== BASELINE =====
async function setBaseline(customDate = null) {
  const coins = await fetchTopCoins(100);
  const filtered = await filterCoins(coins);

  baseline = {
    date: customDate || moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
    setAt: moment().tz("Asia/Kolkata").toISOString(),
    coins: filtered.map((c) => ({
      symbol: c.symbol,
      price: c.quote.INR.price,
      percent: c.quote.USD.percent_change_24h,
    })),
  };

  fs.writeFileSync("./data.json", JSON.stringify(baseline, null, 2));

  return baseline;
}

async function calculateProfit() {
  if (!baseline) return "⚠️ No baseline set.";

  const latest = await fetchTopCoins(100);
  const results = [];

  for (let b of baseline.coins) {
    const current = latest.find((c) => c.symbol === b.symbol);
    if (!current) continue;
    const change = ((current.quote.INR.price - b.price) / b.price) * 100;
    results.push({
      symbol: b.symbol,
      from: b.price,
      to: current.quote.INR.price,
      change,
    });
  }

  results.sort((a, b) => b.change - a.change);

  let text = `📈 Profit since baseline (${baseline.date})`;
  results.slice(0, 10).forEach((r, i) => {
    text += `\n${i + 1}. ${r.symbol} → ${r.change.toFixed(2)}% (from ₹${r.from.toFixed(
      2
    )} to ₹${r.to.toFixed(2)})`;
  });

  return text;
}

// ===== BOT COMMANDS =====
bot.start((ctx) => {
  fs.writeFileSync("./chat.json", JSON.stringify({ chatId: ctx.chat.id }));
  ctx.reply("👋 Welcome! You will receive crypto scanner updates here.");
});

bot.command("status", (ctx) => {
  if (!baseline) return ctx.reply("⚠️ No baseline set.");
  ctx.reply(
    `📊 Baseline date: [${baseline.date}]\nSet at: ${baseline.setAt}\nCoins tracked: ${baseline.coins.length}`
  );
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const arg = ctx.message.text.split(" ")[1];
  const newBaseline = await setBaseline(arg);
  ctx.reply(
    `✅ Baseline set (manual) at ${moment(newBaseline.setAt)
      .tz("Asia/Kolkata")
      .format("D/M/YYYY, h:mm:ss a")}\nDate: [${newBaseline.date}]`
  );
});

bot.command("profit", async (ctx) => {
  ctx.reply(await calculateProfit());
});

bot.command("top10", async (ctx) => {
  if (!baseline || !baseline.coins.length)
    return ctx.reply("⚠️ No coins match filters now.");
  let text = `🔥 Top 10 coins at baseline (${baseline.date})`;
  baseline.coins.slice(0, 10).forEach((c, i) => {
    text += `\n${i + 1}. ${c.symbol} — ₹${c.price.toFixed(2)} (24h: ${c.percent.toFixed(
      2
    )}%)`;
  });
  ctx.reply(text);
});

bot.command("autoprofit", async (ctx) => {
  const arg = ctx.message.text.split(" ")[1];
  if (arg === "on") {
    if (autoProfitJob) autoProfitJob.cancel();
    autoProfitOn = true;
    autoProfitJob = schedule.scheduleJob("*/5 * * * *", async () => {
      const msg = await calculateProfit();
      await bot.telegram.sendMessage(CHAT_ID, "⏱ Auto-profit update:\n\n" + msg);
    });
    ctx.reply("✅ Auto-profit updates ON (every 5 min).");
  } else if (arg === "off") {
    if (autoProfitJob) autoProfitJob.cancel();
    autoProfitOn = false;
    ctx.reply("🛑 Auto-profit updates OFF.");
  } else {
    ctx.reply("Usage: /autoprofit on|off");
  }
});

// ===== DAILY AUTO BASELINE =====
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  const bl = await setBaseline();
  await bot.telegram.sendMessage(
    CHAT_ID,
    `✅ Baseline set (auto) at ${moment(bl.setAt).tz("Asia/Kolkata").format("D/M/YYYY, h:mm:ss a")}\nDate: [${bl.date}]`
  );
});