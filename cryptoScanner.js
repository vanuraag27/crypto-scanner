// cryptoScanner.js
import express from "express";
import { Telegraf } from "telegraf";
import axios from "axios";
import schedule from "node-schedule";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Helpers ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function log(msg) {
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(logDir, "scanner.log"), line + "\n");
}

// --- Persistence files ---
const dataFile = path.join(__dirname, "data.json");
const alertsFile = path.join(__dirname, "alerts.json");

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Load state ---
let persistence = loadJSON(dataFile, { baselineDate: null, setAt: null, coins: [] });
let alerts = loadJSON(alertsFile, { baseline: null, items: [] });

// --- Config from env ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50");
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000"); // 10m
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

// --- Bot ---
const bot = new Telegraf(TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

app.listen(10000, () => log("🌍 Server listening on port 10000"));

// --- Internal state ---
let autoProfitEnabled = false;
let autoProfitJob = null;

// --- Coin fetch ---
async function fetchCoins() {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${FETCH_LIMIT}&convert=USD`;
  const { data } = await axios.get(url, {
    headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
  });
  return data.data;
}

// --- Apply filters for top10 ---
function filterCoins(coins) {
  return coins
    .filter(
      (c) =>
        c.quote.USD.percent_change_24h >= 20 &&
        c.quote.USD.volume_24h >= 50_000_000 &&
        c.quote.USD.market_cap >= 500_000_000
    )
    .sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h)
    .slice(0, 10);
}

// --- Baseline ---
async function setBaseline(manual = false, backdate = null) {
  const coins = await fetchCoins();
  const top10 = filterCoins(coins);
  if (!top10.length) {
    return { ok: false, msg: "⚠️ No coins match filters now." };
  }
  const dateStr = backdate || new Date().toISOString().split("T")[0];
  persistence = {
    baselineDate: dateStr,
    setAt: new Date().toISOString(),
    coins: top10.map((c) => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
    })),
  };
  saveJSON(dataFile, persistence);
  alerts = { baseline: dateStr, items: [] };
  saveJSON(alertsFile, alerts);

  const when = new Date(persistence.setAt).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
  return {
    ok: true,
    msg: `✅ Baseline set (${manual ? "manual" : "auto"}) at ${when}\nDate: ${dateStr}\n` +
      top10
        .map(
          (c, i) =>
            `${i + 1}. ${c.symbol} — $${c.quote.USD.price.toFixed(4)} (24h: ${c.quote.USD.percent_change_24h.toFixed(2)}%)`
        )
        .join("\n"),
  };
}

// --- Profit calculation ---
async function getProfitTable() {
  if (!persistence.baselineDate || persistence.coins.length === 0) {
    return "⚠️ No baseline set yet.";
  }
  const coins = await fetchCoins();
  const map = new Map(coins.map((c) => [c.symbol, c]));
  const lines = persistence.coins.map((b) => {
    const cur = map.get(b.symbol);
    if (!cur) return `${b.symbol} → not found`;
    const now = cur.quote.USD.price;
    const change = ((now - b.price) / b.price) * 100;
    return { sym: b.symbol, change, from: b.price, to: now };
  });
  const sorted = lines.sort((a, b) => b.change - a.change);
  return "📈 Profit since baseline (" + persistence.baselineDate + ")\n" +
    sorted
      .map(
        (x, i) =>
          `${i + 1}. ${x.sym} → ${x.change.toFixed(2)}% (from $${x.from.toFixed(2)} to $${x.to.toFixed(2)})`
      )
      .join("\n");
}

// --- Auto-profit scheduler ---
function startAutoProfit(chatId) {
  if (autoProfitJob) autoProfitJob.cancel();
  autoProfitEnabled = true;
  autoProfitJob = schedule.scheduleJob("*/5 * * * *", async () => {
    const table = await getProfitTable();
    await bot.telegram.sendMessage(chatId, "⏱ Auto-profit update:\n" + table);
  });
}

function stopAutoProfit() {
  if (autoProfitJob) autoProfitJob.cancel();
  autoProfitEnabled = false;
}

// --- Bot Commands ---
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n" +
      "📌 Commands:\n" +
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
    `📊 Baseline date: ${persistence.baselineDate || "N/A"}\n` +
      `Set at: ${persistence.setAt || "N/A"}\n` +
      `Coins tracked: ${persistence.coins.length}\n` +
      `Auto-profit: ${autoProfitEnabled ? "ON" : "OFF"}`
  );
});

bot.command("top10", async (ctx) => {
  if (!persistence.baselineDate) return ctx.reply("⚠️ No baseline set yet.");
  const coins = await fetchCoins();
  const map = new Map(coins.map((c) => [c.symbol, c]));
  const lines = persistence.coins
    .map((b, i) => {
      const cur = map.get(b.symbol);
      if (!cur) return null;
      return `${i + 1}. ${b.symbol} — $${cur.quote.USD.price.toFixed(4)}`;
    })
    .filter(Boolean)
    .join("\n");
  ctx.reply("📊 Baseline Top 10 (" + persistence.baselineDate + ")\n" + lines);
});

bot.command("profit", async (ctx) => {
  const table = await getProfitTable();
  ctx.reply(table);
});

bot.command("alerts", (ctx) => {
  ctx.reply(
    "🔔 Alerts for baseline " +
      (alerts.baseline || "N/A") +
      ":\n" +
      (alerts.items.length ? alerts.items.join("\n") : "None")
  );
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  const parts = ctx.message.text.split(" ");
  const date = parts[1];
  const result = await setBaseline(true, date);
  ctx.reply(result.msg);
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  alerts = { baseline: persistence.baselineDate, items: [] };
  saveJSON(alertsFile, alerts);
  ctx.reply("✅ Alerts cleared.");
});

bot.command("autoprofit", (ctx) => {
  const parts = ctx.message.text.split(" ");
  const arg = parts[1];
  if (arg === "on") {
    startAutoProfit(ctx.chat.id);
    ctx.reply("✅ Auto-profit updates enabled (every 5m).");
  } else if (arg === "off") {
    stopAutoProfit();
    ctx.reply("❌ Auto-profit updates disabled.");
  } else {
    ctx.reply("Usage: /autoprofit on|off");
  }
});

// --- Auto baseline daily ---
schedule.scheduleJob(
  { hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" },
  async () => {
    const result = await setBaseline(false);
    if (result.ok && CHAT_ID) {
      await bot.telegram.sendMessage(CHAT_ID, result.msg);
    }
  }
);

// --- Logs rotation (7 days) ---
schedule.scheduleJob("0 0 * * *", () => {
  const files = fs.readdirSync(logDir).map((f) => path.join(logDir, f));
  if (files.length > 7) {
    files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    while (files.length > 7) {
      const old = files.shift();
      fs.unlinkSync(old);
    }
  }
  log("🧹 Log rotation complete.");
});