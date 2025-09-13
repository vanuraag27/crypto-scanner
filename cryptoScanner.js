// cryptoScanner.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const config = require("./config");

const app = express();
app.use(express.json());

const BASELINE_FILE = path.join(__dirname, "baseline.json");
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const CHAT_FILE = path.join(__dirname, "chat.json");

// ---- helpers: IST day string ----
// returns 'YYYY-MM-DD' for the given date in Asia/Kolkata
function getISTDateString(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}
function getISTTimestamp(d = new Date()) {
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ---- safe read/write JSON ----
function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const txt = fs.readFileSync(filePath, "utf8");
      if (!txt) return fallback;
      return JSON.parse(txt);
    }
  } catch (e) {
    console.error("readJsonSafe error for", filePath, e.message);
  }
  return fallback;
}
function writeJsonSafe(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeJsonSafe error for", filePath, e.message);
  }
}

// ---- state / persistence ----
let baseline = readJsonSafe(BASELINE_FILE, { date: null, time: null, coins: [] });
let alertsStore = readJsonSafe(ALERTS_FILE, { baselineDate: null, alerts: [] });
let savedChat = readJsonSafe(CHAT_FILE, { chatId: null }).chatId || null;

console.log("Loaded persistence:", {
  baselineDate: baseline.date,
  alertsBaseline: alertsStore.baselineDate,
  savedChat
});

// ---- Telegram sending helper ----
async function sendMessage(targetChatId, text, markdown = false) {
  if (!config.USE_TELEGRAM) {
    console.log("[Telegram disabled] would send:", text.slice(0, 300).replace(/\n/g, " "));
    return;
  }
  const token = config.BOT_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_TOKEN. Skipping sendMessage.");
    return;
  }
  if (!targetChatId) {
    console.warn("No chatId available. Skipping message.");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: targetChatId,
      text,
      parse_mode: markdown ? "Markdown" : undefined
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

// ---- fetch market data (CMC) ----
async function fetchTopCoins(limit = config.FETCH_LIMIT) {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
      timeout: 15000
    });
    if (!res.data || !res.data.data) return [];
    return res.data.data.map(c => ({
      symbol: String(c.symbol).toUpperCase(),
      price: Number(c.quote.USD.price),
      change24: Number(c.quote.USD.percent_change_24h)
    }));
  } catch (err) {
    console.error("Error fetching CMC:", err.response?.data || err.message);
    return [];
  }
}

// ---- baseline setter (only schedule or admin can call) ----
async function setBaseline(manual = false) {
  const coins = await fetchTopCoins(config.FETCH_LIMIT);
  if (!coins.length) {
    console.error("setBaseline: no coins fetched; skipping.");
    return false;
  }

  const top10 = coins
    .sort((a, b) => b.change24 - a.change24)
    .slice(0, 10)
    .map(c => ({ symbol: c.symbol, price: c.price, change24: c.change24 }));

  baseline = {
    date: getISTDateString(), // YYYY-MM-DD in IST
    time: new Date().toISOString(),
    coins: top10
  };
  writeJsonSafe(BASELINE_FILE, baseline);

  // reset alerts for new baseline day
  alertsStore = { baselineDate: baseline.date, alerts: [] };
  writeJsonSafe(ALERTS_FILE, alertsStore);

  const when = getISTTimestamp();
  const header = manual ? "✅ Manual baseline set" : `✅ Baseline auto-set (${config.BASELINE_HOUR}:00 IST)`;
  const out = `${header} — ${when}\nBaseline day: ${baseline.date}\nMonitoring top 10:\n` +
    baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(6)} (24h: ${c.change24.toFixed(2)}%)`).join("\n");

  console.log("Baseline set:", baseline.date);
  if (savedChat) await sendMessage(savedChat, out, true);

  return true;
}

// ---- alerts persistence helpers ----
function hasAlerted(symbol) {
  return Array.isArray(alertsStore.alerts) && alertsStore.alerts.includes(symbol);
}
function addAlert(symbol) {
  if (!alertsStore.baselineDate) alertsStore.baselineDate = baseline.date || getISTDateString();
  if (!alertsStore.alerts) alertsStore.alerts = [];
  if (!alertsStore.alerts.includes(symbol)) {
    alertsStore.alerts.push(symbol);
    writeJsonSafe(ALERTS_FILE, alertsStore);
  }
}
function clearAlertsForCurrentBaseline() {
  alertsStore = { baselineDate: baseline.date || getISTDateString(), alerts: [] };
  writeJsonSafe(ALERTS_FILE, alertsStore);
}

// ---- monitoring (only checks prices) ----
async function checkPricesAndTriggerAlerts() {
  if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
    // no baseline set; monitoring does not set baseline
    return;
  }
  const live = await fetchTopCoins(config.FETCH_LIMIT);
  if (!live.length) return;
  const liveMap = new Map(live.map(c => [c.symbol, c]));

  for (const b of baseline.coins) {
    const current = liveMap.get(b.symbol);
    if (!current) continue;
    const pct = ((current.price - b.price) / b.price) * 100;
    if (pct <= config.ALERT_DROP_PERCENT && !hasAlerted(b.symbol)) {
      // fire alert once per baseline day
      addAlert(b.symbol);
      const ts = getISTTimestamp();
      const msg =
        `⚠️ *PRICE ALERT*\n${b.symbol} dropped ${pct.toFixed(2)}% since baseline (${baseline.date})\n` +
        `Baseline: $${b.price.toFixed(6)}\nNow: $${current.price.toFixed(6)}\nTime: ${ts}\n` +
        `Suggested: review position / apply risk management.`;
      if (savedChat) await sendMessage(savedChat, msg, true);
      console.log("Alert sent for", b.symbol, "pct", pct.toFixed(2));
    }
  }
}

// ---- daily summary ----
async function sendDailySummary() {
  if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
    console.log("Daily summary skipped: baseline not set.");
    return;
  }
  const live = await fetchTopCoins(config.FETCH_LIMIT);
  if (!live.length) return;
  const liveMap = new Map(live.map(c => [c.symbol, c]));
  const perf = baseline.coins.map(b => {
    const cur = liveMap.get(b.symbol);
    const currentPrice = cur ? cur.price : b.price;
    const profitPct = ((currentPrice - b.price) / b.price) * 100;
    return { symbol: b.symbol, baseline: b.price, current: currentPrice, profitPct };
  }).sort((a, b) => b.profitPct - a.profitPct);

  const when = getISTTimestamp();
  const out = `📊 Daily Summary (${when}) — Baseline day: ${baseline.date}\n\n` +
    perf.map((p, i) => `${i + 1}. ${p.symbol} — ${p.profitPct.toFixed(2)}% (baseline: $${p.baseline.toFixed(6)} → now: $${p.current.toFixed(6)})`).join("\n");

  if (savedChat) await sendMessage(savedChat, out, true);
  console.log("Daily summary sent.");
}

// ---- webhook routes & commands ----
// allow GET so browser shows alive instead of Cannot GET
app.get("/webhook", (req, res) => res.json({ ok: true, msg: "Webhook endpoint (POST updates here)" }));

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update) return res.sendStatus(200);

    const message = update.message || update.edited_message || null;
    if (!message || !message.text) return res.sendStatus(200);

    const text = message.text.trim();
    const fromId = String(message.from?.id);
    const incomingChatId = message.chat?.id ? String(message.chat.id) : null;

    // /start - register chat (persisted). does NOT change baseline
    if (text === "/start") {
      if (!savedChat) {
        savedChat = incomingChatId;
        writeJsonSafe(CHAT_FILE, { chatId: savedChat });
        await sendMessage(savedChat, "👋 Welcome! This chat is registered to receive scheduled crypto scanner updates. Use /help to see commands.");
        console.log("Saved chatId from /start:", savedChat);
      } else if (savedChat !== incomingChatId) {
        // inform but do not overwrite
        await sendMessage(incomingChatId, "Bot is already configured to deliver scheduled updates to a different chat. Contact admin to change.");
      } else {
        await sendMessage(savedChat, "Bot already configured for this chat. Use /help for commands.");
      }
      return res.sendStatus(200);
    }

    // /help
    if (text === "/help") {
      const help = [
        "📌 Commands:",
        "/start - register this chat to receive scheduled updates",
        "/help - show this message",
        "/status - scanner & baseline status",
        "/top10 - show today's baseline (only after baseline is set)",
        "/profit - ranked % profit since baseline (best→worst)",
        "/alerts - list today's triggered alerts",
        "/setbaseline - admin only (force baseline now)",
        "/clearhistory - admin only (clear today's alerts)"
      ].join("\n");
      await sendMessage(incomingChatId, help);
      return res.sendStatus(200);
    }

    // /status
    if (text === "/status") {
      const baselineInfo = baseline && baseline.date ? `Baseline day: ${baseline.date}` : "Baseline: not set yet";
      const alertsCount = (alertsStore && alertsStore.alerts) ? alertsStore.alerts.length : 0;
      await sendMessage(incomingChatId, `✅ Scanner running.\n${baselineInfo}\nActive alerts today: ${alertsCount}`);
      return res.sendStatus(200);
    }

    // /top10 - must NOT create baseline
    if (text === "/top10") {
      if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
        await sendMessage(incomingChatId, "⚠️ Baseline not set yet. Baseline is only set automatically at the scheduled hour or by admin /setbaseline.");
        return res.sendStatus(200);
      }
      const when = new Date(baseline.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const out = `📊 Baseline Top 10 (day: ${baseline.date}, set at ${when})\n` +
        baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(6)} (24h: ${c.change24.toFixed(2)}%)`).join("\n");
      await sendMessage(incomingChatId, out, true);
      return res.sendStatus(200);
    }

    // /profit - must NOT create baseline
    if (text === "/profit") {
      if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
        await sendMessage(incomingChatId, "⚠️ Baseline not set yet. Baseline is only set automatically at the scheduled hour or by admin /setbaseline.");
        return res.sendStatus(200);
      }
      const live = await fetchTopCoins(config.FETCH_LIMIT);
      const liveMap = new Map(live.map(c => [c.symbol, c]));
      const perf = baseline.coins.map(b => {
        const cur = liveMap.get(b.symbol);
        const current = cur ? cur.price : b.price;
        const pct = ((current - b.price) / b.price) * 100;
        return { symbol: b.symbol, baseline: b.price, current, pct };
      }).sort((a, b) => b.pct - a.pct);

      const out = `📈 Profit since baseline (${baseline.date})\n` +
        perf.map((p, i) => `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.baseline.toFixed(6)} to $${p.current.toFixed(6)})`).join("\n");
      await sendMessage(incomingChatId, out, true);
      return res.sendStatus(200);
    }

    // /alerts
    if (text === "/alerts") {
      const list = (alertsStore && alertsStore.alerts && alertsStore.alerts.length) ? alertsStore.alerts.join(", ") : "None";
      await sendMessage(incomingChatId, `🔔 Alerts for baseline ${alertsStore.baselineDate || "N/A"}:\n${list}`);
      return res.sendStatus(200);
    }

    // ADMIN-only: /setbaseline
    if (text === "/setbaseline") {
      if (!config.ADMIN_ID || String(fromId) !== String(config.ADMIN_ID)) {
        await sendMessage(incomingChatId, "⛔ Not authorized. Admin only.");
        return res.sendStatus(200);
      }
      await setBaseline(true); // manual, notify
      return res.sendStatus(200);
    }

    // ADMIN-only: /clearhistory (clear alerts only)
    if (text === "/clearhistory") {
      if (!config.ADMIN_ID || String(fromId) !== String(config.ADMIN_ID)) {
        await sendMessage(incomingChatId, "⛔ Not authorized. Admin only.");
        return res.sendStatus(200);
      }
      clearAlertsForCurrentBaseline();
      await sendMessage(incomingChatId, "🧹 Alerts cleared for the current baseline day.");
      return res.sendStatus(200);
    }

    // unknown command
    await sendMessage(incomingChatId, "⚠️ Unknown command. Try /help");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.sendStatus(200);
  }
});

// ---- scheduling & monitoring ----
function startSchedulesAndMonitoring() {
  // Monitoring loop: only checks prices and triggers alerts (never changes baseline)
  setInterval(async () => {
    try {
      await checkPricesAndTriggerAlerts();
    } catch (e) {
      console.error("monitor loop error:", e.message);
    }
  }, config.REFRESH_INTERVAL);

  // Scheduled baseline job at configured hour IST
  schedule.scheduleJob({ hour: config.BASELINE_HOUR, minute: 0, tz: "Asia/Kolkata" }, async () => {
    console.log(`[schedule] ${config.BASELINE_HOUR}:00 IST baseline job triggered`);
    const today = getISTDateString();
    if (baseline && baseline.date === today) {
      console.log("Baseline already set for today; skipping scheduled baseline.");
      return;
    }
    await setBaseline(false, true);
  });

  // Daily summary at 22:00 IST
  schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
    console.log("[schedule] 22:00 IST daily summary triggered");
    await sendDailySummary();
  });
}

// ---- startup ----
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  // set webhook only if BASE_URL & BOT_TOKEN provided
  if (config.BASE_URL && config.BOT_TOKEN) {
    try {
      const res = await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook`, {
        params: { url: `${config.BASE_URL}/webhook` }
      });
      console.log("Webhook set result:", res.data && res.data.ok ? `${config.BASE_URL}/webhook` : res.data);
    } catch (err) {
      console.error("❌ Error setting webhook:", err.response?.data || err.message);
    }
  } else {
    console.log("⚠️ BASE_URL or BOT_TOKEN missing; skipping webhook registration.");
  }

  startSchedulesAndMonitoring();
  console.log("🔍 Scanner initialized.");
  console.log(`Baseline will be set automatically at ${config.BASELINE_HOUR}:00 IST, or by admin /setbaseline.`);
});
