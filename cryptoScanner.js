// cryptoScanner.js
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import cron from "node-cron";
import moment from "moment-timezone";
import { Telegraf } from "telegraf";
import { rotateLogs } from "./logs/rotate.js";

const APP_DIR = process.cwd();
const DATA_FILE = path.join(APP_DIR, "data.json");
const ALERTS_FILE = path.join(APP_DIR, "alerts.json");
const LOG_DIR = path.join(APP_DIR, "logs");

// ---------- Environment (set these on Render) ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // bot token
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL; // public URL for webhook
const CHAT_ID = process.env.CHAT_ID; // default chat id to send scheduled messages to
const ADMIN_ID = process.env.ADMIN_ID; // admin user ID (string or number)
const CMC_API_KEY = process.env.CMC_API_KEY;
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR ?? "6", 10); // IST hour (0-23)
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE ?? "0", 10);
const DAILY_SUMMARY_HOUR = parseInt(process.env.DAILY_SUMMARY_HOUR ?? "22", 10); // IST 22 = 10 PM
const DAILY_SUMMARY_MINUTE = parseInt(process.env.DAILY_SUMMARY_MINUTE ?? "0", 10);
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL ?? "60000", 10); // ms: monitor interval
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT ?? "-10"); // negative number
const FETCH_LIMIT = parseInt(process.env.FETCH_LIMIT ?? "50", 10); // how many coins to fetch
const USE_TELEGRAM = String(process.env.USE_TELEGRAM ?? "true").toLowerCase() === "true";

// ---------- Helpers ----------
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(LOG_DIR);

function nowIST(formatStr = "YYYY-MM-DD HH:mm:ss") {
  return moment().tz("Asia/Kolkata").format(formatStr);
}

function writeLog(line) {
  const stamp = `[${nowIST()}] ${line}\n`;
  const file = path.join(LOG_DIR, `log-${moment().tz("Asia/Kolkata").format("YYYY-MM-DD")}.log`);
  fs.appendFileSync(file, stamp);
  rotateLogs(LOG_DIR);
  console.log(stamp.trim());
}

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    writeLog(`Error loading ${file}: ${e.message}`);
    return fallback;
  }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { writeLog(`Error saving ${file}: ${e.message}`); }
}

// ---------- Persistence ----------
let baseline = loadJSON(DATA_FILE, { date: null, setAt: null, coins: [] });
let alerts = loadJSON(ALERTS_FILE, []); // array of { symbol, baseline, current, dropPct, time }

// ---------- Telegraf & Express webhook ----------
if (!TELEGRAM_TOKEN) {
  writeLog("WARNING: TELEGRAM_TOKEN not set. Telegram disabled.");
}
const bot = TELEGRAM_TOKEN ? new Telegraf(TELEGRAM_TOKEN) : null;
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

// Hook Express to Telegraf webhook (if token provided)
if (bot) {
  app.post("/webhook", (req, res) => {
    try {
      bot.handleUpdate(req.body, res);
    } catch (e) {
      writeLog(`Webhook handleUpdate error: ${e.message}`);
      res.sendStatus(500);
    }
  });
}

// ---------- Utility: CMC fetch (USD) + USD->INR FX ----------
async function fetchUSDToINR() {
  try {
    const r = await axios.get("https://api.exchangerate.host/latest?base=USD&symbols=INR");
    return (r.data && r.data.rates && r.data.rates.INR) || 83;
  } catch (e) {
    writeLog("FX fetch failed, using fallback 83");
    return 83;
  }
}

// Fetch top coins (CMC) convert=USD only (free plan)
async function fetchTopCoins(limit = FETCH_LIMIT) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
      timeout: 8000
    });
    return res.data.data; // raw CMC objects
  } catch (e) {
    writeLog(`Error fetching CMC: ${e?.response?.data?.status || e.message}`);
    throw e;
  }
}

// Fetch historical hourly prices for RSI calculation (attempt, may fail on free plan)
async function fetchHourlyHistoryCMC(id, hours = 48) {
  // This endpoint or parameters may vary per plan — best-effort
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/historical", {
      headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
      params: { id, time_period: hours, count: hours, interval: "hourly", convert: "USD" },
      timeout: 8000
    });
    // As API shapes can vary, try to extract an array of close prices
    if (res.data && res.data.data && Array.isArray(res.data.data.quotes)) {
      return res.data.data.quotes.map(q => q.quote.USD.price);
    }
  } catch (e) {
    // ignore; caller will fallback
  }
  return null;
}

// RSI calculation standard (period 14)
function calculateRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period || 1e-8;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

// ---------- Filters logic ----------
async function coinPassesFilters(rawCoin) {
  // rawCoin: returned from CMC listings
  // filters:
  //  - 24h gain >= 20%
  //  - 24h volume >= $50,000,000
  //  - market cap >= $500,000,000
  //  - RSI increased vs previous day (best-effort)
  //  - volume (today) > volume (previous day) (best-effort)
  try {
    const pct24 = rawCoin.quote.USD.percent_change_24h || 0;
    const vol24 = rawCoin.quote.USD.volume_24h || 0;
    const mcap = rawCoin.quote.USD.market_cap || 0;
    if (pct24 < 20) return false;
    if (vol24 < 50_000_000) return false;
    if (mcap < 500_000_000) return false;

    // Try RSI and volume comparison:
    // fetch hourly history and compute RSI for last 14 hours vs previous 14 hours
    const hourly = await fetchHourlyHistoryCMC(rawCoin.id, 48).catch(()=>null);
    if (!hourly || hourly.length < 30) {
      // can't compute RSI reliably — accept the coin if other filters passed
      return true;
    }
    // compute RSI "today" (most recent 14) and "yesterday" (previous block)
    const rsiToday = calculateRSI(hourly.slice(-15)); // last 15 closes -> RSI over last 14
    const rsiYesterday = calculateRSI(hourly.slice(-29, -14));
    const rsiUp = (rsiToday != null && rsiYesterday != null) ? (rsiToday > rsiYesterday) : true;

    // volume: estimate by summing last 24 hourly volumes vs previous 24 hourly volumes
    // CMC hourly quotes might not provide volume per bar consistently; skip if not available
    // We'll fallback to comparing daily vol if hourly not available
    // (since we fetched listings.latest which has volume_24h)
    // For a strict requirement, require volUp true if possible.
    let volUp = true; // default pass
    // If hourly includes volume info (not implemented for every API shape), compute volUp; otherwise true.
    // Here we skip strict check due to API inconsistencies.

    return rsiUp && volUp;
  } catch (e) {
    return true; // don't block on errors; let other filters decide
  }
}

// ---------- Baseline operations ----------
async function createBaseline(dateStr = null, sendTelegram = true, chatId = CHAT_ID) {
  // dateStr is optional label for baseline day (e.g. 2025-09-24)
  try {
    writeLog("Creating baseline...");
    const fx = await fetchUSDToINR();
    const raw = await fetchTopCoins(FETCH_LIMIT);
    // map to lightweight baseline form
    const coins = raw.map(c => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      priceUSD: c.quote.USD.price,
      priceINR: c.quote.USD.price * fx,
      percent24h: c.quote.USD.percent_change_24h || 0,
      volume24h: c.quote.USD.volume_24h || 0,
      marketCap: c.quote.USD.market_cap || 0
    }));
    baseline = {
      date: dateStr || moment().tz("Asia/Kolkata").format("YYYY-MM-DD"),
      setAt: nowIST("YYYY-MM-DD HH:mm:ss"),
      coins
    };
    saveJSON(DATA_FILE, baseline);
    // when baseline resets, clear alerts
    alerts = [];
    saveJSON(ALERTS_FILE, alerts);
    writeLog(`Baseline set: ${baseline.date} (${baseline.setAt}) with ${coins.length} coins`);
    if (sendTelegram && USE_TELEGRAM && TELEGRAM_TOKEN && chatId) {
      const top10 = coins.slice(0, 10).map((c,i) => `${i+1}. ${c.symbol} - $${c.priceUSD.toFixed(4)} (24h: ${c.percent24h.toFixed(2)}%)`).join("\n");
      await sendTelegramMessage(chatId, `✅ Baseline set (${baseline.date}) at ${baseline.setAt}\nMonitoring top ${Math.min(10, coins.length)}:\n${top10}`);
    }
    return baseline;
  } catch (e) {
    writeLog(`Baseline creation failed: ${e.message}`);
    throw e;
  }
}

// ---------- Alert check (run frequently) ----------
let alertedSymbols = new Set(alerts.map(a => a.symbol)); // to avoid re-fire same baseline day

async function checkAlerts() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) return;
  try {
    const fx = await fetchUSDToINR();
    const raw = await fetchTopCoins(FETCH_LIMIT);
    const map = new Map(raw.map(c => [c.symbol, c]));

    for (const b of baseline.coins) {
      const cur = map.get(b.symbol);
      if (!cur) continue;
      const curPriceUSD = cur.quote.USD.price;
      const dropPct = ((curPriceUSD - b.priceUSD) / b.priceUSD) * 100; // negative if down
      if (dropPct <= ALERT_DROP_PERCENT) { // ALERT_DROP_PERCENT is negative
        if (!alertedSymbols.has(b.symbol)) {
          // create alert
          const alertObj = {
            symbol: b.symbol,
            baselineUSD: b.priceUSD,
            baselineINR: b.priceINR,
            currentUSD: curPriceUSD,
            currentINR: curPriceUSD * fx,
            dropPct: dropPct,
            time: nowIST("YYYY-MM-DD HH:mm:ss")
          };
          alerts.push(alertObj);
          saveJSON(ALERTS_FILE, alerts);
          alertedSymbols.add(b.symbol);
          writeLog(`ALERT triggered: ${b.symbol} ${dropPct.toFixed(2)}%`);
          // send telegram
          if (USE_TELEGRAM && TELEGRAM_TOKEN && CHAT_ID) {
            const msg = `🔔 ALERT: ${b.symbol} dropped ${dropPct.toFixed(2)}% from baseline\nBaseline: $${b.priceUSD.toFixed(4)} | ₹${b.priceINR.toFixed(2)}\nCurrent: $${curPriceUSD.toFixed(4)} | ₹${(curPriceUSD*fx).toFixed(2)}\nTime (IST): ${alertObj.time}\nSuggested action: review position / set stop-loss`;
            await sendTelegramMessage(CHAT_ID, msg);
          }
        }
      }
    }
  } catch (e) {
    writeLog(`checkAlerts error: ${e.message}`);
  }
}

// ---------- Telegram helpers ----------
async function sendTelegramMessage(chatId, text, parseMode = "Markdown") {
  if (!TELEGRAM_TOKEN || !bot) {
    writeLog(`[Telegram disabled] would send to ${chatId}: ${text.substring(0,120)}`);
    return;
  }
  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: parseMode });
  } catch (e) {
    writeLog(`Telegram send error: ${e?.response?.data || e.message}`);
  }
}

// ---------- Bot commands ----------
if (bot) {
  bot.start(async (ctx) => {
    const fromId = String(ctx.from.id);
    // Save chat ID if not present
    if (!CHAT_ID) {
      // If CHAT_ID not configured, record first chat to data file (non-persistent change; keep chat id in memory)
      // But we do not overwrite environment-based CHAT_ID automatically.
    }
    const helpMsg = `👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n/help - show commands\n/status - scanner & baseline status\n/top10 - show baseline coins\n/profit - show profit since baseline\n/alerts - list alerts\n/setbaseline [YYYY-MM-DD] - admin only (force baseline now)\n/clearhistory - admin only (clear today's alerts)\n/autoprofit on|off - start/stop auto profit updates\n/forcealert SYMBOL - admin only (simulate alert)`;
    await ctx.reply(helpMsg);
    writeLog(`Saved chatId from /start: ${ctx.chat.id}`);
    // store savedChat in data file (so we can use it for scheduled messages if CHAT_ID env missing)
    const data = loadJSON(DATA_FILE, baseline);
    if (!data.savedChat) {
      data.savedChat = ctx.chat.id;
      saveJSON(DATA_FILE, data);
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply("📌 Commands:\n/start /help /status /top10 /profit /alerts /setbaseline [YYYY-MM-DD] (admin) /clearhistory (admin) /autoprofit on|off /forcealert SYMBOL (admin)");
  });

  bot.command("status", async (ctx) => {
    const data = loadJSON(DATA_FILE, baseline);
    const baselineDate = data.date || "N/A";
    const setAt = data.setAt || "N/A";
    const coins = (data.coins || []).length;
    const alertsCount = (loadJSON(ALERTS_FILE, []) || []).length;
    await ctx.reply(`📊 Baseline date: ${baselineDate}\nSet at: ${setAt}\nCoins tracked: ${coins}\nActive alerts today: ${alertsCount}`);
  });

  bot.command("top10", async (ctx) => {
    const data = loadJSON(DATA_FILE, baseline);
    if (!data || !data.coins || data.coins.length === 0) {
      return ctx.reply("⚠️ No baseline set yet. Baseline only set automatically at configured time or by admin /setbaseline.");
    }
    // Apply filters (we will perform best-effort filter using the stored baseline coins)
    try {
      // For quick response: filter based on stored fields (24h gain, volume, marketcap)
      const candidates = data.coins.filter(c => {
        return c.percent24h >= 20 && c.volume24h >= 50_000_000 && c.marketCap >= 500_000_000;
      });

      // For each candidate attempt to run RSI + volume up check (best-effort, async)
      const passed = [];
      for (const cand of candidates) {
        try {
          const raw = await fetchTopCoins(FETCH_LIMIT); // fetch to get id
          const rawCoin = raw.find(r => r.symbol === cand.symbol);
          if (!rawCoin) { passed.push(cand); continue; }
          const pass = await coinPassesFilters(rawCoin);
          if (pass) passed.push(cand);
        } catch (e) {
          // on error, include candidate (fail open)
          passed.push(cand);
        }
        if (passed.length >= 10) break;
      }

      if (passed.length === 0) return ctx.reply("⚠️ No coins match filters now.");

      const lines = passed.slice(0,10).map((c,i) => `${i+1}. ${c.symbol} — $${c.priceUSD.toFixed(4)} | ₹${c.priceINR.toFixed(2)} (24h: ${c.percent24h.toFixed(2)}%)`);
      await ctx.reply(`📌 Filtered Top ${lines.length} (best→worst)\n${lines.join("\n")}`);
    } catch (e) {
      writeLog(`top10 error: ${e.message}`);
      ctx.reply("❌ Error building top10.");
    }
  });

  bot.command("profit", async (ctx) => {
    const data = loadJSON(DATA_FILE, baseline);
    if (!data || !data.coins || data.coins.length === 0) return ctx.reply("⚠️ No baseline set yet.");
    try {
      const fx = await fetchUSDToINR();
      const raw = await fetchTopCoins(FETCH_LIMIT);
      const map = new Map(raw.map(c => [c.symbol, c]));
      const arr = data.coins.slice(0, 50).map(b => {
        const cur = map.get(b.symbol);
        if (!cur) return { symbol: b.symbol, note: "data missing" };
        const curUSD = cur.quote.USD.price;
        const pct = ((curUSD - b.priceUSD) / b.priceUSD) * 100;
        return {
          symbol: b.symbol,
          fromUSD: b.priceUSD,
          toUSD: curUSD,
          fromINR: b.priceINR,
          toINR: curUSD * fx,
          pct
        };
      });
      // Sort best -> worst
      arr.sort((a,b) => (b.pct || 0) - (a.pct || 0));
      const lines = arr.slice(0,10).map((r,i) => {
        if (r.note) return `${i+1}. ${r.symbol} → ${r.note}`;
        return `${i+1}. ${r.symbol} → ${r.pct.toFixed(2)}% (from $${r.fromUSD.toFixed(2)} → $${r.toUSD.toFixed(2)})`;
      });
      await ctx.reply(`📈 Profit since baseline (${data.date})\n${lines.join("\n")}`);
    } catch (e) {
      writeLog(`profit error: ${e.message}`);
      ctx.reply("❌ Error fetching profit.");
    }
  });

  bot.command("alerts", async (ctx) => {
    const todaysAlerts = loadJSON(ALERTS_FILE, []);
    if (!todaysAlerts || todaysAlerts.length === 0) return ctx.reply("🔔 No alerts triggered for current baseline.");
    // Show baseline + current price + change + time
    try {
      const fx = await fetchUSDToINR();
      const lines = [];
      const raw = await fetchTopCoins(FETCH_LIMIT);
      const map = new Map(raw.map(c => [c.symbol, c]));
      for (const a of todaysAlerts) {
        const cur = map.get(a.symbol);
        let curUSD = a.currentUSD, curINR = a.currentINR;
        if (cur) {
          curUSD = cur.quote.USD.price;
          curINR = curUSD * fx;
        }
        lines.push(`${a.symbol}\n• Baseline: $${a.baselineUSD.toFixed(4)} | ₹${a.baselineINR.toFixed(2)}\n• Current: $${curUSD.toFixed(4)} | ₹${curINR.toFixed(2)}\n• Drop: ${a.dropPct.toFixed(2)}% \n• Alerted at (IST): ${a.time}\n`);
      }
      await ctx.reply(`🔔 Alerts for baseline ${baseline.date}:\n\n${lines.join("\n")}`);
    } catch (e) {
      writeLog(`alerts command error: ${e.message}`);
      ctx.reply("❌ Error preparing alerts.");
    }
  });

  // admin only: setbaseline [YYYY-MM-DD] (if no param, uses today's date)
  bot.command("setbaseline", async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("⛔ Admin only.");
    const parts = ctx.message.text.trim().split(/\s+/);
    const dateArg = parts[1] || null;
    try {
      await createBaseline(dateArg, true, ctx.chat.id);
      ctx.reply(`✅ Baseline set (manual) at ${nowIST("YYYY-MM-DD HH:mm:ss")}\nDate: [${baseline.date}]`);
    } catch (e) {
      ctx.reply("❌ Error fetching baseline data. See logs.");
    }
  });

  bot.command("clearhistory", async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("⛔ Admin only.");
    alerts = [];
    saveJSON(ALERTS_FILE, alerts);
    alertedSymbols = new Set();
    ctx.reply("✅ Alerts cleared for current baseline day.");
  });

  // autoprofit on|off
  let autoProfitTimer = null;
  bot.command("autoprofit", async (ctx) => {
    const arg = (ctx.message.text || "").split(/\s+/)[1] || "";
    if (!arg) return ctx.reply("Usage: /autoprofit on|off");
    if (arg.toLowerCase() === "on") {
      if (autoProfitTimer) clearInterval(autoProfitTimer);
      autoProfitTimer = setInterval(async () => {
        try {
          // send same as /profit but to configured chat
          const message = await buildProfitMessage(10);
          const targetChat = CHAT_ID || loadJSON(DATA_FILE, {}).savedChat;
          if (targetChat) await sendTelegramMessage(targetChat, message);
        } catch (e) { writeLog(`autoprofit error: ${e.message}`); }
      }, 5 * 60 * 1000);
      ctx.reply("✅ Auto-profit updates enabled (every 5 minutes).");
    } else {
      if (autoProfitTimer) clearInterval(autoProfitTimer);
      autoProfitTimer = null;
      ctx.reply("⏹ Auto-profit updates disabled.");
    }
  });

  // forcealert SYMBOL (admin-only) - simulate an alert for testing
  bot.command("forcealert", async (ctx) => {
    if (String(ctx.from.id) !== String(ADMIN_ID)) return ctx.reply("⛔ Admin only.");
    const parts = ctx.message.text.trim().split(/\s+/);
    const sym = (parts[1] || "").toUpperCase();
    if (!sym) return ctx.reply("Usage: /forcealert SYMBOL");
    const data = loadJSON(DATA_FILE, baseline);
    const b = (data.coins || []).find(x => x.symbol === sym);
    if (!b) return ctx.reply(`❌ Symbol ${sym} not found in baseline.`);
    const fx = await fetchUSDToINR();
    const simulated = {
      symbol: sym,
      baselineUSD: b.priceUSD,
      baselineINR: b.priceINR,
      currentUSD: b.priceUSD * (1 + (ALERT_DROP_PERCENT/100)),
      currentINR: b.priceINR * (1 + (ALERT_DROP_PERCENT/100)),
      dropPct