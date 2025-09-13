const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
const bot = new Telegraf(config.BOT_TOKEN);

// --- Webhook setup ---
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${config.BASE_URL}/webhook`);

// --- Persistence files ---
const baselineFile = path.join(__dirname, "baseline.json");
const alertsFile = path.join(__dirname, "alerts.json");

let baseline = { date: null, coins: [] };
let alerts = { baselineDate: null, fired: [] };

// --- Load persistence ---
function loadPersistence() {
  if (fs.existsSync(baselineFile)) {
    baseline = JSON.parse(fs.readFileSync(baselineFile, "utf-8"));
  }
  if (fs.existsSync(alertsFile)) {
    alerts = JSON.parse(fs.readFileSync(alertsFile, "utf-8"));
  }
}
function saveBaseline() {
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
}
function saveAlerts() {
  fs.writeFileSync(alertsFile, JSON.stringify(alerts, null, 2));
}
loadPersistence();

// --- Utility ---
function nowIST() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function todayDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// --- Crypto fetcher ---
async function fetchTopCoins(limit = 20) {
  const res = await axios.get(
    "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
    {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" }
    }
  );
  return res.data.data.map(c => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h
  }));
}

// --- Baseline setter ---
async function setBaseline(manual = false) {
  const date = todayDate();
  const coins = await fetchTopCoins(20);

  baseline = {
    date,
    setAt: nowIST(),
    coins: coins.slice(0, 10) // take top 10
  };
  alerts = { baselineDate: date, fired: [] };

  saveBaseline();
  saveAlerts();

  if (config.USE_TELEGRAM && config.CHAT_ID) {
    let msg = manual
      ? `✅ Manual baseline set — ${nowIST()}`
      : `✅ Baseline set (auto at ${config.BASELINE_HOUR}:00 IST ${date})`;
    msg += `\nMonitoring top 10:\n`;
    baseline.coins.forEach((c, i) => {
      msg += `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(2)}%)\n`;
    });
    await bot.telegram.sendMessage(config.CHAT_ID, msg);
  }
  console.log("✅ Baseline set and saved");
}

// --- Monitoring & alerts ---
async function checkAlerts() {
  if (!baseline.date) return;
  const current = await fetchTopCoins(50);
  const date = todayDate();
  if (date !== baseline.date) return; // only same day

  for (let b of baseline.coins) {
    const live = current.find(c => c.symbol === b.symbol);
    if (!live) continue;
    const drop = ((live.price - b.price) / b.price) * 100;
    if (drop <= -10 && !alerts.fired.includes(b.symbol)) {
      alerts.fired.push(b.symbol);
      saveAlerts();
      if (config.USE_TELEGRAM && config.CHAT_ID) {
        await bot.telegram.sendMessage(
          config.CHAT_ID,
          `🚨 Alert: ${b.symbol} dropped ${drop.toFixed(2)}%\nBaseline: $${b.price.toFixed(
            4
          )}\nNow: $${live.price.toFixed(4)}\nTime: ${nowIST()}`
        );
      }
    }
  }
}

// --- Daily summary at 10 PM ---
async function sendDailySummary() {
  if (!baseline.date) return;
  const current = await fetchTopCoins(20);
  let msg = `📊 Daily Summary (${todayDate()})\nBaseline set at ${baseline.setAt}\n\n`;
  const perf = baseline.coins.map(b => {
    const live = current.find(c => c.symbol === b.symbol);
    const pct = ((live.price - b.price) / b.price) * 100;
    return { symbol: b.symbol, pct, from: b.price, to: live.price };
  });
  perf.sort((a, b) => b.pct - a.pct);
  perf.forEach((p, i) => {
    msg += `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.from.toFixed(
      4
    )} → $${p.to.toFixed(4)})\n`;
  });
  if (config.USE_TELEGRAM && config.CHAT_ID) {
    await bot.telegram.sendMessage(config.CHAT_ID, msg);
  }
}

// --- Scheduler ---
function scheduleJobs() {
  setInterval(async () => {
    const now = new Date();
    const hour = now.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

    // Auto baseline
    if (hour === `${config.BASELINE_HOUR}:00` && baseline.date !== todayDate()) {
      await setBaseline();
    }

    // 10 PM summary
    if (hour === "22:00") {
      await sendDailySummary();
    }
  }, 60 * 1000); // check every minute

  // Alerts check
  setInterval(checkAlerts, config.REFRESH_INTERVAL);
}

// --- Commands ---
bot.start(async ctx => {
  config.CHAT_ID = ctx.chat.id;
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show today's baseline\n" +
      "/profit - profit since baseline\n" +
      "/alerts - list active alerts\n" +
      "/setbaseline - admin only\n" +
      "/clearhistory - admin only"
  );
});

bot.command("status", ctx => {
  ctx.reply(
    baseline.date
      ? `✅ Scanner running.\nBaseline: ${baseline.date}, set at ${baseline.setAt}\nAlerts today: ${alerts.fired.length}`
      : "⚠️ Baseline not set yet."
  );
});

bot.command("top10", ctx => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  let msg = `📊 Baseline Top 10 (${baseline.date}, set at ${baseline.setAt})\n`;
  baseline.coins.forEach((c, i) => {
    msg += `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(2)}%)\n`;
  });
  ctx.reply(msg);
});

bot.command("profit", async ctx => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  const current = await fetchTopCoins(20);
  const perf = baseline.coins.map(b => {
    const live = current.find(c => c.symbol === b.symbol);
    const pct = ((live.price - b.price) / b.price) * 100;
    return { symbol: b.symbol, pct, from: b.price, to: live.price };
  });
  perf.sort((a, b) => b.pct - a.pct);
  let msg = `📈 Profit since baseline (${baseline.date}):\n`;
  perf.forEach((p, i) => {
    msg += `${i + 1}. ${p.symbol} → ${p.pct.toFixed(2)}% (from $${p.from.toFixed(
      4
    )} → $${p.to.toFixed(4)})\n`;
  });
  ctx.reply(msg);
});

bot.command("alerts", ctx => {
  if (!baseline.date) return ctx.reply("⚠️ Baseline not set yet.");
  ctx.reply(
    alerts.fired.length
      ? `🔔 Alerts (${baseline.date}): ${alerts.fired.join(", ")}`
      : `🔔 Alerts (${baseline.date}): None`
  );
});

bot.command("setbaseline", async ctx => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) {
    return ctx.reply("⛔ Admin only");
  }
  await setBaseline(true);
});

bot.command("clearhistory", ctx => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) {
    return ctx.reply("⛔ Admin only");
  }
  alerts = { baselineDate: baseline.date, fired: [] };
  saveAlerts();
  ctx.reply("✅ Alerts history cleared");
});

// --- Start ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log(`✅ Webhook set to ${config.BASE_URL}/webhook`);
  console.log("🔍 Scanner initialized.");
  console.log(
    `📅 Baseline will be set automatically each day at ${config.BASELINE_HOUR}:00 IST, or by admin /setbaseline.`
  );
  scheduleJobs();
});
