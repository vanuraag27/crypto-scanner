// cryptoScanner.js
// Complete scanner with webhook, baseline, alerts, logs, filters

const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

// ====== ENV CONFIG ======
const TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHAT_ID = process.env.CHAT_ID;
const BASE_URL = process.env.BASE_URL;
const CMC_API_KEY = process.env.CMC_API_KEY;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL || "600000");
const ALERT_DROP_PERCENT = parseFloat(process.env.ALERT_DROP_PERCENT || "-10");
const BASELINE_HOUR = parseInt(process.env.BASELINE_HOUR || "6");
const BASELINE_MINUTE = parseInt(process.env.BASELINE_MINUTE || "0");

// ====== FILES ======
const persistenceFile = path.join(__dirname, "data.json");
const alertsFile = path.join(__dirname, "alerts.json");
const logsDir = path.join(__dirname, "logs");

// ====== HELPERS ======
function log(msg) {
  const now = new Date();
  const line = `[${now.toLocaleString("en-IN")}] ${msg}`;
  console.log(line);

  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
  const file = path.join(logsDir, `${now.toISOString().split("T")[0]}.log`);
  fs.appendFileSync(file, line + "\n");

  // keep only 7 days
  const files = fs.readdirSync(logsDir);
  if (files.length > 7) {
    files
      .sort()
      .slice(0, files.length - 7)
      .forEach(f => fs.unlinkSync(path.join(logsDir, f)));
  }
}

function loadJSON(file, def) {
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return def;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ====== STATE ======
let persistence = loadJSON(persistenceFile, { date: null, setAt: null, coins: [] });
let alerts = loadJSON(alertsFile, { date: null, symbols: [] });

// ====== TELEGRAM ======
const bot = new Telegraf(TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));
bot.telegram.setWebhook(`${BASE_URL}/webhook`);

app.get("/", (req, res) => res.send("Crypto Scanner running"));
app.listen(10000, () => log("🌍 Server listening on port 10000"));

// ====== CMC API ======
async function fetchTop(limit = 50) {
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${limit}&convert=USD`;
  const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_API_KEY } });
  return res.data.data;
}

// ====== BASELINE ======
async function setBaseline(manual = false) {
  const coins = await fetchTop(100);

  const top = coins
    .filter(c => {
      const gain24h = c.quote.USD.percent_change_24h;
      const vol24h = c.quote.USD.volume_24h;
      const mc = c.quote.USD.market_cap;
      return gain24h >= 20 && vol24h >= 50_000_000 && mc >= 500_000_000;
    })
    .slice(0, 10)
    .map(c => ({
      symbol: c.symbol,
      name: c.name,
      price: c.quote.USD.price,
      percent24h: c.quote.USD.percent_change_24h,
      volume24h: c.quote.USD.volume_24h,
      marketCap: c.quote.USD.market_cap
    }));

  persistence = {
    date: new Date().toISOString().split("T")[0],
    setAt: new Date().toLocaleString("en-IN"),
    coins: top
  };
  saveJSON(persistenceFile, persistence);

  alerts = { date: persistence.date, symbols: [] };
  saveJSON(alertsFile, alerts);

  log(`✅ Baseline set (${manual ? "manual" : "auto"}) with ${top.length} coins`);
  if (CHAT_ID) {
    bot.telegram.sendMessage(
      CHAT_ID,
      `✅ Baseline set (${manual ? "manual" : "auto"}) at ${persistence.setAt}\n` +
        top
          .map(
            (c, i) =>
              `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.percent24h.toFixed(2)}%)`
          )
          .join("\n")
    );
  }
}

// ====== ALERTS ======
async function checkAlerts() {
  if (!persistence.date) return;
  const coins = await fetchTop(100);
  for (let base of persistence.coins) {
    const live = coins.find(c => c.symbol === base.symbol);
    if (!live) continue;

    const change = ((live.quote.USD.price - base.price) / base.price) * 100;
    if (change <= ALERT_DROP_PERCENT && !alerts.symbols.includes(base.symbol)) {
      alerts.symbols.push(base.symbol);
      saveJSON(alertsFile, alerts);
      log(`🚨 ALERT: ${base.symbol} dropped ${change.toFixed(2)}%`);

      if (CHAT_ID) {
        bot.telegram.sendMessage(
          CHAT_ID,
          `🚨 ALERT: ${base.symbol}\nDrop: ${change.toFixed(2)}%\nBaseline: $${base.price.toFixed(
            4
          )}\nNow: $${live.quote.USD.price.toFixed(4)}\nTime: ${new Date().toLocaleString("en-IN")}`
        );
      }
    }
  }
}

// ====== COMMANDS ======
bot.start(ctx => {
  saveJSON(persistenceFile, persistence);
  ctx.reply(
    "👋 Welcome to Crypto Scanner!\n\n📌 Commands:\n" +
      "/status – scanner status\n" +
      "/top10 – today's baseline top 10\n" +
      "/profit – profit since baseline\n" +
      "/alerts – active alerts\n" +
      "/setbaseline – admin only\n" +
      "/clearhistory – admin only\n" +
      "/logs – last 7 days logs"
  );
});

bot.command("status", ctx => {
  ctx.reply(
    `✅ Scanner running.\nBaseline: ${
      persistence.date ? persistence.date : "not set"
    }\nActive alerts: ${alerts.symbols.length}`
  );
});

bot.command("top10", ctx => {
  if (!persistence.date) return ctx.reply("⚠️ Baseline not set yet.");
  ctx.reply(
    `📊 Baseline Top 10 (day ${persistence.date})\n\n` +
      persistence.coins
        .map(
          (c, i) =>
            `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.percent24h.toFixed(2)}%)`
        )
        .join("\n")
  );
});

bot.command("profit", async ctx => {
  if (!persistence.date) return ctx.reply("⚠️ Baseline not set yet.");
  const coins = await fetchTop(100);
  const list = persistence.coins.map(base => {
    const live = coins.find(c => c.symbol === base.symbol);
    const change = ((live.quote.USD.price - base.price) / base.price) * 100;
    return {
      symbol: base.symbol,
      change,
      from: base.price,
      to: live.quote.USD.price
    };
  });
  ctx.reply(
    `📈 Profit since baseline (${persistence.date})\n\n` +
      list
        .sort((a, b) => b.change - a.change)
        .map(
          (c, i) =>
            `${i + 1}. ${c.symbol} → ${c.change.toFixed(2)}% (from $${c.from.toFixed(
              4
            )} to $${c.to.toFixed(4)})`
        )
        .join("\n")
  );
});

bot.command("alerts", ctx => {
  ctx.reply(
    `🔔 Alerts for baseline ${persistence.date || "N/A"}:\n` +
      (alerts.symbols.length ? alerts.symbols.join(", ") : "None")
  );
});

bot.command("setbaseline", ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  setBaseline(true);
  ctx.reply("✅ Manual baseline set.");
});

bot.command("clearhistory", ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  alerts = { date: persistence.date, symbols: [] };
  saveJSON(alertsFile, alerts);
  ctx.reply("🧹 Alerts cleared for today.");
});

bot.command("logs", ctx => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
  const files = fs.readdirSync(logsDir).sort().slice(-7);
  ctx.reply("📜 Logs available:\n" + files.join("\n"));
});

// ====== SCHEDULER ======
schedule.scheduleJob({ hour: BASELINE_HOUR, minute: BASELINE_MINUTE, tz: "Asia/Kolkata" }, () =>
  setBaseline(false)
);
setInterval(checkAlerts, REFRESH_INTERVAL);

log(
  `Configuration: baseline ${BASELINE_HOUR}:${BASELINE_MINUTE} IST | refresh ${REFRESH_INTERVAL} ms | alert drop ${ALERT_DROP_PERCENT}%`
);