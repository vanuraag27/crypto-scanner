// cryptoScanner.js
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
  REFRESH_INTERVAL,  // Note: This isn't used in your code—consider removing if unused
  BASELINE_HOUR,
  BASELINE_MINUTE
} = require("./config");

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
// (Keep all your bot.command handlers here, unchanged)

// --- Start Bot ---
console.log(`🔍 Scanner initialized.`);
console.log(
  `📅 Baseline will be set automatically each day at ${BASELINE_HOUR}:${BASELINE_MINUTE
    .toString()
    .padStart(2, "0")} IST, or by admin /setbaseline.`
);

bot.launch();
