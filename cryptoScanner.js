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

let baseline = { date: null, coins: [] }; // loaded from file
let alertsStore = { baselineDate: null, alerts: [] }; // { baselineDate: 'YYYY-MM-DD', alerts: ['BTC','ETH'] }
let chatId = null;

// ---------- Helpers: load/save ----------
function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      const txt = fs.readFileSync(filePath, "utf8");
      return JSON.parse(txt || "null") || fallback;
    }
  } catch (e) {
    console.error("readJsonSafe error", filePath, e.message);
  }
  return fallback;
}

function writeJsonSafe(filePath, obj) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeJsonSafe error", filePath, e.message);
  }
}

function loadAllPersistence() {
  baseline = readJsonSafe(BASELINE_FILE, baseline);
  alertsStore = readJsonSafe(ALERTS_FILE, alertsStore);
  const chatObj = readJsonSafe(CHAT_FILE, { chatId: null });
  chatId = chatObj.chatId || null;
  console.log("Loaded persistence:", {
    baselineDate: baseline.date,
    alertsBaseline: alertsStore.baselineDate,
    savedChat: chatId
  });
}

function saveBaselineToDisk() {
  writeJsonSafe(BASELINE_FILE, baseline);
}
function saveAlertsToDisk() {
  writeJsonSafe(ALERTS_FILE, alertsStore);
}
function saveChatToDisk() {
  writeJsonSafe(CHAT_FILE, { chatId });
}

// ---------- Telegram send ----------
async function sendMessage(targetChatId, text, markdown = false) {
  if (!config.USE_TELEGRAM) {
    console.log("[Telegram disabled] would send:", text.slice(0, 200));
    return;
  }
  const token = config.BOT_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_TOKEN in env. Cannot send message.");
    return;
  }
  if (!targetChatId) {
    console.warn("No chatId available. Skipping Telegram message.");
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

// ---------- Market data ----------
async function fetchTopCoins(limit = config.FETCH_LIMIT) {
  const url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest";
  try {
    const res = await axios.get(url, {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" }
    });
    if (!res.data || !res.data.data) return [];
    return res.data.data.map((c) => ({
      symbol: String(c.symbol).toUpperCase(),
      price: Number(c.quote.USD.price),
      change24: Number(c.quote.USD.percent_change_24h)
    }));
  } catch (err) {
    console.error("Error fetching top coins:", err.response?.data || err.message);
    return [];
  }
}

// ---------- Baseline (only set by schedule or admin) ----------
function baselineDateString() {
  // YYYY-MM-DD (IST)
  const now = new Date();
  const tz = now.toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }); // 'YYYY-MM-DD HH:MM:SS'
  return tz.split(" ")[0];
}

async function setBaseline(manual = false, notify = true) {
  // fetch coins and set baseline top 10 (by 24h change)
  const coins = await fetchTopCoins(config.FETCH_LIMIT);
  if (!coins.length) {
    console.error("Cannot set baseline — no coins fetched.");
    return false;
  }

  // choose top 10 by 24h percent change (descending)
  const top10 = coins
    .sort((a, b) => b.change24 - a.change24)
    .slice(0, 10)
    .map((c) => ({ symbol: c.symbol, price: c.price, change24: c.change24 }));

  baseline = {
    date: baselineDateString(), // day
    time: new Date().toISOString(),
    coins: top10
  };
  saveBaselineToDisk();

  // reset alertsStore to new baseline day
  alertsStore = { baselineDate: baseline.date, alerts: [] };
  saveAlertsToDisk();

  if (notify && chatId) {
    const header = manual ? "✅ Manual baseline set" : "✅ Baseline auto-set (6:00 AM IST)";
    const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const out =
      `${header} — ${when}\nMonitoring top 10 (baseline day: ${baseline.date}):\n` +
      baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} - $${c.price.toFixed(4)} (24h: ${c.change24.toFixed(2)}%)`).join("\n");
    await sendMessage(chatId, out, true);
  } else {
    console.log("Baseline set (no chat to notify).");
  }
  console.log("Baseline saved for day", baseline.date);
  return true;
}

// ---------- Alerts persistence logic ----------
function hasAlertedFor(symbol) {
  return alertsStore.alerts.includes(symbol);
}
function addAlert(symbol) {
  if (!alertsStore.baselineDate) alertsStore.baselineDate = baseline.date || baselineDateString();
  if (!alertsStore.alerts.includes(symbol)) {
    alertsStore.alerts.push(symbol);
    saveAlertsToDisk();
  }
}
function resetAlertsForNewBaseline(newBaselineDate) {
  alertsStore = { baselineDate: newBaselineDate, alerts: [] };
  saveAlertsToDisk();
}

// ---------- Monitoring (only checks prices) ----------
async function checkPricesAndTriggerAlerts() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) {
    // no baseline set -> monitoring runs but does nothing
    return;
  }
  const live = await fetchTopCoins(config.FETCH_LIMIT);
  if (!live.length) return;

  // map live prices
  const liveMap = new Map(live.map((c) => [c.symbol, c]));

  for (const b of baseline.coins) {
    const liveCoin = liveMap.get(b.symbol);
    if (!liveCoin) continue;

    // compute percent change from baseline price
    const pct = ((liveCoin.price - b.price) / b.price) * 100;

    // Alert condition: pct <= ALERT_DROP_PERCENT (e.g. -10)
    if (pct <= config.ALERT_DROP_PERCENT && !hasAlertedFor(b.symbol)) {
      // record alert and send message once for this baseline day
      addAlert(b.symbol);

      const timeStamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const msg =
        `⚠️ *PRICE ALERT*\n${b.symbol} is down ${pct.toFixed(2)}% since baseline (${baseline.date})\n` +
        `Baseline: $${b.price.toFixed(4)}\nNow: $${liveCoin.price.toFixed(4)}\nTime: ${timeStamp}\n` +
        `Suggested: Review & consider risk management.`;
      if (chatId) await sendMessage(chatId, msg, true);
      console.log("Alert sent for", b.symbol, "pct", pct.toFixed(2));
    }
  }
}

// ---------- Daily summary at 10:00 PM IST ----------
async function sendDailySummary() {
  if (!baseline || !baseline.coins || baseline.coins.length === 0) {
    console.log("Daily summary: baseline not set — skipping.");
    return;
  }
  const live = await fetchTopCoins(config.FETCH_LIMIT);
  if (!live.length) return;

  // compute profit% for baseline coins
  const liveMap = new Map(live.map((c) => [c.symbol, c]));
  const perf = baseline.coins.map((b) => {
    const cur = liveMap.get(b.symbol);
    const currentPrice = cur ? cur.price : b.price;
    const profitPct = ((currentPrice - b.price) / b.price) * 100;
    return { symbol: b.symbol, baseline: b.price, current: currentPrice, profitPct };
  });

  perf.sort((a, b) => b.profitPct - a.profitPct); // best -> worst

  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  let out = `📊 Daily Summary (${when}) — Baseline day: ${baseline.date}\n\nTop → Bottom performers:\n`;
  out += perf.map((p, i) => `${i + 1}. ${p.symbol} — ${p.profitPct.toFixed(2)}% (Baseline: $${p.baseline.toFixed(4)} → Now: $${p.current.toFixed(4)})`).join("\n");

  if (chatId) await sendMessage(chatId, out, true);
  console.log("Daily summary sent.");
}

// ---------- Webhook / Command handling ----------
// GET /webhook -> simple health check (so browser won't show Cannot GET)
app.get("/webhook", (req, res) => {
  res.status(200).send({ ok: true, msg: "Webhook endpoint is alive. POST updates here." });
});

// POST /webhook -> Telegram updates arrive here
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (!update) return res.sendStatus(200);

    // support both message and edited_message
    const message = update.message || update.edited_message || null;
    if (!message || !message.text) return res.sendStatus(200);

    const text = message.text.trim();
    const fromId = String(message.from?.id);
    const incomingChatId = message.chat?.id;

    // /start: store chat id (only once per chat)
    if (text === "/start") {
      if (!chatId) {
        chatId = incomingChatId;
        saveChatToDisk();
        await sendMessage(chatId, "👋 Welcome! You will receive crypto scanner updates here. Use /help to see commands.");
        console.log("Saved chatId from /start:", chatId);
      } else if (String(chatId) !== String(incomingChatId)) {
        // optional: inform other user the bot is active but not the configured chat
        await sendMessage(incomingChatId, "Bot is active. Only the configured chat receives scheduled updates.");
      } else {
        await sendMessage(chatId, "Bot already configured for this chat. Use /help for commands.");
      }
      return res.sendStatus(200);
    }

    // commands that must not change baseline: check baseline not auto-created here
    if (text === "/help") {
      const help = [
        "📌 Commands:",
        "/start - register this chat to receive scheduled updates",
        "/help - show this message",
        "/status - scanner & baseline status",
        "/top10 - show today's baseline (only after 6:00 AM or admin set)",
        "/profit - ranked % profit since baseline (best→worst)",
        "/alerts - list current alerted symbols for today",
        "/setbaseline - admin only (force baseline now)",
        "/clearhistory - admin only (clears alerts for current baseline day)"
      ].join("\n");
      await sendMessage(incomingChatId, help);
      return res.sendStatus(200);
    }

    if (text === "/status") {
      const baselineInfo = baseline && baseline.date ? `Baseline day: ${baseline.date}` : "Baseline: not set yet";
      const alertsCount = alertsStore?.alerts?.length || 0;
      await sendMessage(incomingChatId, `✅ Scanner running.\n${baselineInfo}\nActive alerts today: ${alertsCount}`);
      return res.sendStatus(200);
    }

    if (text === "/top10") {
      if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
        await sendMessage(incomingChatId, "⚠️ Baseline not set yet. Baseline is only set at 6:00 AM IST or by admin /setbaseline.");
        return res.sendStatus(200);
      }
      const when = new Date(baseline.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const out = `📊 Baseline Top 10 (day: ${baseline.date}, set at ${when})\n` +
        baseline.coins.map((c, i) => `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change24.toFixed(2)}%)`).join("\n");
      await sendMessage(incomingChatId, out, true);
      return res.sendStatus(200);
    }

    if (text === "/profit") {
      if (!baseline || !baseline.date || !baseline.coins || baseline.coins.length === 0) {
        await sendMessage(incomingChatId, "⚠️ Baseline not set yet. Baseline is set only at 6:00 AM IST or by admin /setbaseline.");
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
        perf.map((p, i) => `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.baseline.toFixed(4)} to $${p.current.toFixed(4)})`).join("\n");
      await sendMessage(incomingChatId, out, true);
      return res.sendStatus(200);
    }

    if (text === "/alerts") {
      const list = alertsStore.alerts && alertsStore.alerts.length ? alertsStore.alerts.join(", ") : "None";
      await sendMessage(incomingChatId, `🔔 Alerts for baseline ${alertsStore.baselineDate || "N/A"}:\n${list}`);
      return res.sendStatus(200);
    }

    // ADMIN-only: /setbaseline (force) and /clearhistory (clear alerts)
    if (text.startsWith("/setbaseline")) {
      if (!config.ADMIN_ID || String(fromId) !== String(config.ADMIN_ID)) {
        await sendMessage(incomingChatId, "⛔ Not authorized. Admin only.");
        return res.sendStatus(200);
      }
      await setBaseline(true, true); // manual + notify
      return res.sendStatus(200);
    }

    if (text.startsWith("/clearhistory")) {
      if (!config.ADMIN_ID || String(fromId) !== String(config.ADMIN_ID)) {
        await sendMessage(incomingChatId, "⛔ Not authorized. Admin only.");
        return res.sendStatus(200);
      }
      // per rules: reset alerts.json (does not reset baseline)
      alertsStore = { baselineDate: alertsStore.baselineDate || baseline.date || baselineDateString(), alerts: [] };
      saveAlertsToDisk();
      await sendMessage(incomingChatId, "🧹 Alerts cleared for current baseline day.");
      return res.sendStatus(200);
    }

    // unknown command fallback
    await sendMessage(incomingChatId, "⚠️ Unknown command. Try /help");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.sendStatus(200);
  }
});

// ---------- Scheduling & monitoring ----------
function startMonitoringAndSchedules() {
  // 1) Monitoring loop: runs every REFRESH_INTERVAL, only checks prices & triggers alerts
  setInterval(async () => {
    try {
      await checkPricesAndTriggerAlerts();
    } catch (e) {
      console.error("monitor interval error:", e.message);
    }
  }, config.REFRESH_INTERVAL);

  // 2) Daily baseline job: 6:00 AM IST
  schedule.scheduleJob({ hour: 6, minute: 0, tz: "Asia/Kolkata" }, async () => {
    console.log("Scheduled job: 6:00 AM IST - set baseline");
    await setBaseline(false, true); // auto baseline, notify saved chat if available
  });

  // 3) Daily summary job: 10:00 PM IST
  schedule.scheduleJob({ hour: 22, minute: 0, tz: "Asia/Kolkata" }, async () => {
    console.log("Scheduled job: 10:00 PM IST - daily summary");
    await sendDailySummary();
  });
}

// ---------- Startup ----------
loadAllPersistence();

// IMPORTANT: Do NOT auto-create baseline on startup. Wait for 6:00 AM or admin /setbaseline.
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  // auto-register webhook only if BASE_URL exists
  if (config.BASE_URL && config.BOT_TOKEN) {
    try {
      const setRes = await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook`, {
        params: { url: `${config.BASE_URL}/webhook` }
      });
      if (setRes.data && setRes.data.ok) {
        console.log("✅ Webhook set to", `${config.BASE_URL}/webhook`);
      } else {
        console.warn("Webhook set result:", setRes.data);
      }
    } catch (err) {
      console.error("❌ Error setting webhook:", err.response?.data || err.message);
    }
  } else {
    console.log("⚠️ BASE_URL or BOT_TOKEN not set. Skipping webhook registration (if you use polling locally, set BOT_TOKEN only).");
  }

  // start monitoring and schedule jobs
  startMonitoringAndSchedules();

  console.log("🔍 Scanner initialized.");
  console.log("Baseline will be set automatically at 6:00 AM IST, or by admin /setbaseline.");
});
