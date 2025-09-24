/**
 * cryptoScanner.js
 * - Webhook-only Telegraf bot
 * - Baseline (live or historical), alerts, persistence, logs
 * - Mix: CoinMarketCap for live, CoinGecko for historical daily snapshots
 *
 * Requirements (env):
 * TELEGRAM_TOKEN, BASE_URL, CHAT_ID, ADMIN_ID, CMC_API_KEY
 * optional: REFRESH_INTERVAL (ms), ALERT_DROP_PERCENT (e.g. -10), BASELINE_HOUR, BASELINE_MINUTE, FETCH_LIMIT
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const schedule = require("node-schedule");
const { Telegraf } = require("telegraf");

// ---------------------------
// Config from environment
// ---------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = process.env.BASE_URL; // e.g. https://crypto-scanner-jaez.onrender.com
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const CMC_API_KEY = process.env.CMC_API_KEY;

const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "60000", 10); // default 60s monitoring
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10"); // e.g. -10
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6", 10);
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0", 10);
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT || "50", 10); // how many coins to fetch when scanning

if (!TELEGRAM_TOKEN || !BASE_URL || !CMC_API_KEY || !CHAT_ID || !ADMIN_ID) {
  console.error("Missing required environment variables. Please set TELEGRAM_TOKEN, BASE_URL, CMC_API_KEY, CHAT_ID, ADMIN_ID.");
  process.exit(1);
}

// ---------------------------
// Files & folders
// ---------------------------
const DATA_FILE = path.join(__dirname, "data.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const LOGS_DIR = path.join(__dirname, "logs");

// ensure logs dir
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---------------------------
// Utilities: Time & Logging
// ---------------------------
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayISO_IST() {
  // date string in YYYY-MM-DD using IST
  const d = new Date();
  const s = d.toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }); // "YYYY-MM-DD, hh:mm:ss"
  return s.split(",")[0];
}

function appendLog(msg) {
  const line = `[${nowIST()}] ${msg}\n`;
  const file = path.join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(file, line);
  console.log(line.trim());

  // rotate keep last 7 days
  try {
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith(".log")).sort();
    const keep = 7;
    if (files.length > keep) {
      const remove = files.slice(0, files.length - keep);
      for (const r of remove) fs.unlinkSync(path.join(LOGS_DIR, r));
    }
  } catch (e) {
    console.error("Log rotate error:", e.message);
  }
}

// ---------------------------
// Persistence helpers
// ---------------------------
function loadJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    appendLog(`Error reading ${file}: ${e.message}`);
    return fallback;
  }
}
function saveJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// persisted state
let baseline = loadJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
// alertsPersisted: { date: 'YYYY-MM-DD', symbols: [] }
let alertsPersisted = loadJSON(ALERTS_FILE, { date: null, symbols: [] });

// ---------------------------
// Telegram Bot (webhook mode)
// ---------------------------
const bot = new Telegraf(TELEGRAM_TOKEN);

// helper send (safe)
async function safeSend(chatId, text, opts = {}) {
  try {
    await bot.telegram.sendMessage(chatId, text, opts);
  } catch (err) {
    appendLog(`Telegram send error: ${err.response?.data || err.message}`);
  }
}

// admin checker
function isAdmin(ctx) {
  return String(ctx.from?.id) === String(ADMIN_ID);
}

// ---------------------------
// CoinMarketCap - live fetch
// ---------------------------
async function fetchCMCListings(limit = FETCH_LIMIT) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" }
    });
    return res.data.data;
  } catch (err) {
    appendLog("CMC fetch error: " + (err.response?.data?.status || err.message));
    return [];
  }
}

// map CMC coin -> simplified object
function mapCMC(c) {
  return {
    id: c.id,
    name: c.name,
    symbol: c.symbol,
    price: c.quote.USD.price,
    change24h: c.quote.USD.percent_change_24h,
    volume24h: c.quote.USD.volume_24h,
    marketCap: c.quote.USD.market_cap
  };
}

// ---------------------------
// CoinGecko - historical helpers (free daily snapshots)
// ---------------------------
// We'll use CoinGecko's /coins/markets (current) to list top coins (by current market cap).
// For historical price for a coin at a given date, we'll call /coins/{id}/history?date=DD-MM-YYYY
// To map symbol->id we use /coins/list once and cache it.

let coinGeckoIdMap = null;
async function loadCoinGeckoIdMap() {
  if (coinGeckoIdMap) return coinGeckoIdMap;
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/list");
    // returns {id, symbol, name}
    coinGeckoIdMap = {};
    for (const coin of res.data) {
      coinGeckoIdMap[coin.symbol.toUpperCase()] = coin.id;
    }
    return coinGeckoIdMap;
  } catch (err) {
    appendLog("CoinGecko list error: " + err.message);
    coinGeckoIdMap = {};
    return coinGeckoIdMap;
  }
}

/**
 * Fetch historical price for a single coin symbol on given date (YYYY-MM-DD)
 * Returns null on failure.
 * Note: CoinGecko expects date in DD-MM-YYYY format and returns market_data.current_price.usd.
 */
async function fetchHistoricalPriceForSymbol(symbol, dateISO) {
  try {
    const map = await loadCoinGeckoIdMap();
    const id = map[symbol.toUpperCase()];
    if (!id) return null;
    const [y, m, d] = dateISO.split("-");
    const dateCG = `${d}-${m}-${y}`; // DD-MM-YYYY
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}/history`, {
      params: { date: dateCG }
    });
    const price = res.data?.market_data?.current_price?.usd;
    return typeof price === "number" ? price : null;
  } catch (err) {
    appendLog(`CoinGecko history error for ${symbol} ${dateISO}: ${err.message}`);
    return null;
  }
}

/**
 * Build a historical baseline for a given date (YYYY-MM-DD).
 * Implementation strategy:
 * - Use CoinGecko current top market cap list (per_page=FETCH_LIMIT) to get candidate coins and their ids.
 * - For each candidate (up to top N), query their /history for the date to get the price.
 * - Keep only those that return a valid price and satisfy basic filters if needed.
 *
 * Note: This is an approximation. With no paid historical markets endpoint, we cannot perfectly reconstruct the exact top-gainers at that past moment.
 */
async function buildHistoricalBaseline(dateISO, desiredCount = 10) {
  appendLog(`Building historical baseline for ${dateISO} (approx)`);
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/markets", {
      params: {
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: FETCH_LIMIT,
        page: 1,
        sparkline: false
      }
    });
    const marketList = res.data; // has id, symbol, current_price, market_cap, total_volume, price_change_percentage_24h
    const candidates = marketList.slice(0, FETCH_LIMIT);

    const baselineCoins = [];
    for (const c of candidates) {
      if (baselineCoins.length >= desiredCount) break;
      const price = await fetchHistoricalPriceForSymbol(c.symbol, dateISO);
      if (price === null) continue;
      // use historical price; we don't have historical 24h change/volume reliably, so we store price and current-ish meta
      baselineCoins.push({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        price,
        // use available fields from current markets as approximate, but mark them as approximate
        approx_marketCap: c.market_cap || null,
        approx_volume24h: c.total_volume || null
      });
      // be mindful of rate limits: pause a tiny bit if necessary (not added here)
    }

    appendLog(`Historical baseline built with ${baselineCoins.length} coins (date ${dateISO})`);
    return baselineCoins.slice(0, desiredCount);
  } catch (err) {
    appendLog("Error building historical baseline: " + err.message);
    return [];
  }
}

// ---------------------------
// Baseline management
// ---------------------------
function persistBaselineToDisk(baselineObj) {
  baseline = baselineObj;
  saveJSON();
  // reset today's alerts
  alertsPersisted = { date: baseline.date, symbols: [] };
  saveJSON(ALERTS_FILE, alertsPersisted);
}

function saveJSON() {
  saveJSON_helper(DATA_FILE, baseline);
}
function saveJSON_helper(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// wrapper to save alerts
function saveAlertsPersisted() {
  saveJSON_helper(ALERTS_FILE, alertsPersisted);
}

// Convenience: format coin list for messages
function formatBaselineList(coins) {
  if (!coins || !coins.length) return " (none) ";
  return coins.map((c, i) => {
    const priceStr = (typeof c.price === "number") ? `$${c.price.toFixed(6)}` : `${c.price}`;
    const changeStr = c.change24h != null ? ` (24h: ${c.change24h.toFixed(2)}%)` : "";
    return `${i + 1}. ${c.symbol} — ${priceStr}${changeStr}`;
  }).join("\n");
}

// ---------------------------
// Core: set baseline (live or historical)
// /setbaseline -> live
// /setbaseline YYYY-MM-DD -> historical daily
// ---------------------------
async function setBaselineCommand(opts = { manual: false, dateISO: null, ctx: null }) {
  const { manual, dateISO, ctx } = opts;
  try {
    if (!dateISO) {
      // Live baseline using CMC
      const listings = await fetchCMCListings(Math.max(50, FETCH_LIMIT));
      // map and filter according to rules: 24h gain >=20, vol >=50M, mcap >=500M
      const mapped = listings.map(mapCMC);
      const filtered = mapped
        .filter(c => c.change24h != null && c.change24h >= 20 && c.volume24h >= 50_000_000 && c.marketCap >= 500_000_000)
        .sort((a, b) => b.change24h - a.change24h)
        .slice(0, 10)
        .map(c => ({
          symbol: c.symbol,
          name: c.name,
          price: c.price,
          change24h: c.change24h,
          volume24h: c.volume24h,
          marketCap: c.marketCap
        }));

      const date = todayISO_IST();
      const setAt = nowIST();
      const obj = { date, setAt, coins: filtered };
      saveJSON_helper(DATA_FILE, obj);
      baseline = obj;
      // reset alerts
      alertsPersisted = { date: baseline.date, symbols: [] };
      saveAlertsPersisted();

      const msg = `✅ Baseline set (${manual ? "manual" : "auto"}) at ${setAt}\nDate: ${date}\n${formatBaselineList(filtered)}`;
      appendLog(msg);
      if (CHAT_ID) await safeSend(CHAT_ID, msg);
      if (ctx) ctx && ctx.reply && ctx.reply("✅ Baseline set (live).");
      return true;
    } else {
      // Historical baseline using CoinGecko (approx daily)
      // dateISO expected in YYYY-MM-DD
      const coins = await buildHistoricalBaseline(dateISO, 10);
      if (!coins || coins.length === 0) {
        const failMsg = `⚠️ Could not build historical baseline for ${dateISO}.`;
        appendLog(failMsg);
        if (ctx) ctx.reply(failMsg);
        return false;
      }
      const setAt = nowIST();
      const obj = { date: dateISO, setAt, coins };
      saveJSON_helper(DATA_FILE, obj);
      baseline = obj;
      // reset alerts
      alertsPersisted = { date: baseline.date, symbols: [] };
      saveAlertsPersisted();

      const msg = `✅ Historical baseline set for ${dateISO} (approx) at ${setAt}\n${formatBaselineList(coins)}`;
      appendLog(msg);
      if (CHAT_ID) await safeSend(CHAT_ID, msg);
      if (ctx) ctx.reply && ctx.reply(`✅ Baseline set for ${dateISO} (approx).`);
      return true;
    }
  } catch (err) {
    appendLog("Error in setBaselineCommand: " + err.message);
    if (ctx) ctx.reply && ctx.reply("❌ Error setting baseline: " + err.message);
    return false;
  }
}

// ---------------------------
// Alerts checker (periodic)
// - compares current live price (CMC) vs baseline.price and fires if drop <= ALERT_DROP_PERCENT
// - persists alerts so won't re-fire for same symbol on same baseline date
// ---------------------------
async function checkAlertsNow() {
  try {
    if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
      // nothing to check
      return;
    }
    const listings = await fetchCMCListings(Math.max(200, FETCH_LIMIT));
    const liveMap = new Map(listings.map(c => [c.symbol, mapCMC(c)]));

    const today = todayISO_IST();
    if (alertsPersisted.date !== baseline.date) {
      // baseline changed/ new day: reset
      alertsPersisted = { date: baseline.date, symbols: [] };
      saveAlertsPersisted();
    }

    for (const base of baseline.coins) {
      const live = liveMap.get(base.symbol);
      if (!live || typeof live.price !== "number" || typeof base.price !== "number") continue;
      const pct = ((live.price - base.price) / base.price) * 100;
      if (pct <= ALERT_DROP_PERCENT && !alertsPersisted.symbols.includes(base.symbol)) {
        // fire alert
        const text = `🚨 ALERT: ${base.symbol}\nDrop: ${pct.toFixed(2)}%\nBaseline: $${base.price}\nNow: $${live.price}\nTime (IST): ${nowIST()}`;
        appendLog(text);
        if (CHAT_ID) await safeSend(CHAT_ID, text);
        alertsPersisted.symbols.push(base.symbol);
        saveAlertsPersisted();
      }
    }
  } catch (err) {
    appendLog("checkAlertsNow error: " + err.message);
  }
}

// ---------------------------
// Commands (webhook)
// ---------------------------
bot.start(async (ctx) => {
  // save the chat id so we can send scheduled messages to the user who started it
  const chatId = ctx.chat?.id;
  if (chatId && String(chatId) !== String(CHAT_ID)) {
    appendLog(`Saved chat from /start: ${chatId} (previous CHAT_ID env: ${CHAT_ID})`);
    // optionally override CHAT_ID? For safety we keep CHAT_ID from env, but record savedChat for info
    // You can change behavior: if you want the bot to send to whoever used /start,
    // you can persist this chatId and use it.
  }
  const helpMsg = `👋 Welcome! Commands:
/help - this message
/status - scanner & baseline status
/top10 - show today's baseline (only after baseline set)
/profit - ranked % profit since baseline (best→worst)
/alerts - list current alerts for baseline
/setbaseline - admin only (now)
/setbaseline YYYY-MM-DD - admin only (historical daily snapshot, approx)
/clearhistory - admin only (clears today's alerts)
/logs - admin only (list last 7 log files)`;
  ctx.reply(helpMsg);
});

bot.command("help", (ctx) => {
  ctx.reply("See /start for command list.");
});

bot.command("status", (ctx) => {
  const date = baseline.date || "Not set";
  const setAt = baseline.setAt || "N/A";
  const alertsCount = Array.isArray(alertsPersisted.symbols) ? alertsPersisted.symbols.length : 0;
  ctx.reply(`✅ Scanner status
Baseline date: ${date}
Baseline set at: ${setAt}
Alerts today: ${alertsCount}
Last checked: ${nowIST()}`);
});

bot.command("top10", (ctx) => {
  if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
    return ctx.reply("⚠️ Baseline not set yet. Wait for scheduled baseline (6:00 IST) or use /setbaseline (admin).");
  }
  const msg = `📊 Baseline Top ${baseline.coins.length} (date: ${baseline.date})\nSet at: ${baseline.setAt}\n\n${formatBaselineList(baseline.coins)}`;
  ctx.reply(msg);
});

bot.command("profit", async (ctx) => {
  if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
    return ctx.reply("⚠️ Baseline not set yet. Wait for scheduled baseline (6:00 IST) or use /setbaseline (admin).");
  }
  // fetch live prices
  const listings = await fetchCMCListings(Math.max(200, FETCH_LIMIT));
  const liveMap = new Map(listings.map(c => [c.symbol, mapCMC(c)]));
  const profitList = [];
  for (const base of baseline.coins) {
    const live = liveMap.get(base.symbol);
    if (!live || typeof live.price !== "number") continue;
    const pct = ((live.price - base.price) / base.price) * 100;
    profitList.push({ symbol: base.symbol, from: base.price, to: live.price, pct });
  }
  profitList.sort((a, b) => b.pct - a.pct);
  if (!profitList.length) return ctx.reply("No live data available to compute profit.");

  const text = `📈 Profit since baseline (${baseline.date})
Baseline set at: ${baseline.setAt}
Last checked: ${nowIST()}

${profitList.map((p, i) => `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.from} to $${p.to})`).join("\n")}`;
  ctx.reply(text);
});

bot.command("alerts", (ctx) => {
  const list = (alertsPersisted && alertsPersisted.symbols && alertsPersisted.symbols.length) ? alertsPersisted.symbols.join(", ") : "None";
  ctx.reply(`🔔 Alerts for baseline ${baseline.date || "N/A"} (set at ${baseline.setAt || "N/A"})
Last checked: ${nowIST()}

Active alerts: ${list}`);
});

// /setbaseline [YYYY-MM-DD] admin-only
bot.command("setbaseline", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text?.trim() || "";
  const parts = text.split(/\s+/);
  if (parts.length === 1) {
    // live baseline now
    await setBaselineCommand({ manual: true, dateISO: null, ctx });
  } else {
    const dateArg = parts[1];
    // validate YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      return ctx.reply("Invalid date format. Use YYYY-MM-DD (example: /setbaseline 2025-09-24)");
    }
    await setBaselineCommand({ manual: true, dateISO: dateArg, ctx });
  }
});

// /clearhistory admin-only: reset alerts for current baseline day
bot.command("clearhistory", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  alertsPersisted = { date: baseline.date || null, symbols: [] };
  saveAlertsPersisted();
  ctx.reply("✅ Alerts cleared for current baseline day.");
  appendLog("Admin cleared alerts.");
});

// /logs admin-only: list available log files (last 7)
bot.command("logs", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  try {
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith(".log")).sort();
    const last = files.slice(-7);
    ctx.reply(`📜 Logs (last ${last.length}):\n${last.join("\n")}`);
  } catch (e) {
    ctx.reply("Error reading logs: " + e.message);
  }
});

// ---------------------------
// Scheduler: baseline daily at BASELINE_HOUR:BASELINE_MINUTE IST
// ---------------------------
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, async () => {
  appendLog(`Scheduled baseline job triggered (IST ${BASELINE_HOUR}:${BASELINE_MINUTE})`);
  await setBaselineCommand({ manual: false, dateISO: null, ctx: null });
});

// Monitoring interval: check alerts periodically
setInterval(checkAlertsNow, Math.max(10_000, REFRESH_INTERVAL)); // not less than 10s

// ---------------------------
// Webhook server setup
// ---------------------------
const app = express();
app.use(express.json());
app.use(bot.webhookCallback("/webhook"));

(async () => {
  try {
    // set webhook
    const whRes = await bot.telegram.setWebhook(`${BASE_URL.replace(/\/$/, "")}/webhook`);
    appendLog(`✅ Webhook set to ${BASE_URL.replace(/\/$/, "")}/webhook (response: ${JSON.stringify(whRes)})`);
  } catch (e) {
    appendLog("Webhook set failed: " + (e.response?.data?.description || e.message));
  }

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    appendLog(`🌍 Server listening on port ${PORT}`);
    appendLog(`Configuration: BASELINE ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | REFRESH_INTERVAL ${REFRESH_INTERVAL} ms | ALERT_DROP_PERCENT ${ALERT_DROP_PERCENT}%`);
    if (!baseline || !baseline.date) {
      appendLog(`⚠️ No baseline set yet. Will auto-create at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST or admin /setbaseline.`);
    } else {
      appendLog(`Baseline loaded for date ${baseline.date} setAt ${baseline.setAt}`);
    }
  });
})();

// ---------------------------
// init: if data file exists, baseline variable set earlier via loadJSON; we loaded at top
// ---------------------------
appendLog(`Loaded persistence: ${JSON.stringify({ date: baseline.date, setAt: baseline.setAt, coinsCount: (baseline.coins||[]).length })}`);
appendLog(`Loaded alerts state: ${JSON.stringify(alertsPersisted)}`);

// ---------------------------
// Export for testing (if needed)
// ---------------------------
module.exports = {
  fetchCMCListings,
  fetchHistoricalPriceForSymbol,
  setBaselineCommand,
  checkAlertsNow
};