// cryptoScanner.js
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const axios = require("axios");
const cron = require("node-cron");
const moment = require("moment-timezone");
const { Telegraf } = require("telegraf");

const {
  TELEGRAM_TOKEN,
  CHAT_ID,
  ADMIN_ID,
  CMC_API_KEY,
  REFRESH_INTERVAL,
  BASELINE_HOUR,
  BASELINE_MINUTE
} = require("./config");

const app = express();
app.use(bodyParser.json());

// Persistence file
const baselineFile = "./baseline.json";
let persistence = {
  baselineDate: null,
  alertsBaseline: null,
  savedChat: null,
  coins: []
};

// Load persistence
if (fs.existsSync(baselineFile)) {
  persistence = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  console.log("Loaded persistence:", persistence);
}

// Save persistence
function savePersistence() {
  fs.writeFileSync(baselineFile, JSON.stringify(persistence, null, 2));
}

// Telegram bot
const bot = new Telegraf(TELEGRAM_TOKEN);

// Express webhook endpoint
app.post("/webhook", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// --- Helper: format IST time ---
function nowIST() {
  return moment().tz("Asia/Kolkata");
}

// --- Set Baseline ---
async function setBaseline(manual = false) {
  try {
    const response = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
        params: { start: 1, limit: 10, convert: "USD" }
      }
    );

    const top10 = response.data.data.map(c => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h
    }));

    persistence.baselineDate = nowIST().format("YYYY-MM-DD");
    persistence.coins = top10;
    persistence.alertsBaseline = {};
    savePersistence();

    const time = nowIST().format("D/M/YYYY, h:mm:ss a");
    const baselineMsg = `${manual ? "✅ Manual" : "✅ Auto"} baseline set — ${time}\nMonitoring top 10:\n${top10
      .map(
        (c, i) =>
          `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(2)}%)`
      )
      .join("\n")}`;

    await bot.telegram.sendMessage(CHAT_ID, baselineMsg);
    console.log("Baseline set at:", time);
  } catch (err) {
    console.error("Error setting baseline:", err.message);
  }
}

// --- Scheduler for Baseline ---
cron.schedule(
  `${BASELINE_MINUTE} ${BASELINE_HOUR} * * *`,
  () => {
    console.log(`⏰ Running scheduled baseline at ${BASELINE_HOUR}:${BASELINE_MINUTE} IST`);
    setBaseline(false);
  },
  { timezone: "Asia/Kolkata" }
);

// --- Telegram Commands ---
bot.start(async ctx => {
  persistence.savedChat = ctx.chat.id;
  savePersistence();
  await ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/start - register this chat\n" +
      "/status - scanner & baseline status\n" +
      "/top10 - show today's baseline\n" +
      "/profit - ranked % profit since baseline\n" +
      "/alerts - list current alerts\n" +
      "/setbaseline - admin only (force baseline)\n" +
      "/clearhistory - admin only (reset alerts)"
  );
});

bot.command("setbaseline", async ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  await setBaseline(true);
});

bot.command("status", async ctx => {
  const baselineDay = persistence.baselineDate || "N/A";
  const msg = `✅ Scanner running.\nBaseline day: ${baselineDay}\nActive alerts today: ${
    persistence.alertsBaseline ? Object.keys(persistence.alertsBaseline).length : 0
  }`;
  ctx.reply(msg);
});

bot.command("top10", async ctx => {
  if (!persistence.baselineDate || persistence.coins.length === 0) {
    return ctx.reply("⚠️ Baseline not set yet. Only at baseline hour or admin /setbaseline.");
  }
  const msg = `📊 Baseline Top 10 (day: ${persistence.baselineDate})\n${persistence.coins
    .map(
      (c, i) =>
        `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(2)}%)`
    )
    .join("\n")}`;
  ctx.reply(msg);
});

bot.command("profit", async ctx => {
  if (!persistence.baselineDate || persistence.coins.length === 0) {
    return ctx.reply("⚠️ Baseline not set yet. Only at baseline hour or admin /setbaseline.");
  }
  try {
    const response = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY },
        params: { start: 1, limit: 10, convert: "USD" }
      }
    );
    const latest = response.data.data;
    const profits = persistence.coins.map(base => {
      const now = latest.find(c => c.symbol === base.symbol);
      if (!now) return null;
      const diff = ((now.quote.USD.price - base.price) / base.price) * 100;
      return { symbol: base.symbol, baseline: base.price, current: now.quote.USD.price, profit: diff };
    }).filter(Boolean);

    const msg = `📈 Profit since baseline (${persistence.baselineDate}):\n${profits
      .sort((a, b) => b.profit - a.profit)
      .map(
        (p, i) =>
          `${i + 1}. ${p.symbol} → ${p.profit.toFixed(2)}% (from $${p.baseline.toFixed(
            4
          )} to $${p.current.toFixed(4)})`
      )
      .join("\n")}`;
    ctx.reply(msg);
  } catch (err) {
    ctx.reply("❌ Error fetching profit data.");
  }
});

// --- Start Server & Bot ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
  console.log(`🔍 Scanner initialized.`);
  console.log(
    `📅 Baseline will be set automatically each day at ${BASELINE_HOUR}:${BASELINE_MINUTE
      .toString()
      .padStart(2, "0")} IST, or by admin /setbaseline.`
  );
});

bot.launch();
