// cryptoScanner.js
const express = require("express");
const { Telegraf } = require("telegraf");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const config = require("./config");
const { log } = require("./logger");

// persistence
let persistence = {
  baselineDate: null,
  coins: [],
  alertsBaseline: null,
  savedChat: null
};

const persistenceFile = path.join(__dirname, "baseline.json");
if (fs.existsSync(persistenceFile)) {
  persistence = JSON.parse(fs.readFileSync(persistenceFile, "utf-8"));
  log("Loaded persistence: " + JSON.stringify(persistence, null, 2));
} else {
  log("No persistence found, starting fresh.");
}

function savePersistence() {
  fs.writeFileSync(persistenceFile, JSON.stringify(persistence, null, 2));
}

// telegram setup
const bot = new Telegraf(config.TELEGRAM_TOKEN);
const app = express();
app.use(bot.webhookCallback("/webhook"));

const webhookUrl = `${config.BASE_URL}/webhook`;
bot.telegram.setWebhook(webhookUrl);
app.listen(config.PORT, () => {
  log(`🌍 Server running on port ${config.PORT}`);
  log(`Webhook set result: ${webhookUrl}`);
});

// -------------------- BOT COMMANDS --------------------
bot.start((ctx) => {
  persistence.savedChat = ctx.chat.id;
  savePersistence();
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n📌 Commands:\n" +
      "/status – scanner & baseline status\n" +
      "/top10 – show today's baseline list\n" +
      "/profit – ranked % profit since baseline\n" +
      "/alerts – list current alerts\n" +
      "/setbaseline – admin only\n" +
      "/clearhistory – admin only\n" +
      "/logs – admin only (last 30 log lines)"
  );
  log(`Saved chatId from /start: ${ctx.chat.id}`);
});

bot.command("status", (ctx) => {
  ctx.reply(
    `✅ Scanner running.\nBaseline day: ${persistence.baselineDate || "Not set"}\nActive alerts today: ${persistence.alertsBaseline || 0}`
  );
});

bot.command("top10", (ctx) => {
  if (!persistence.baselineDate) {
    return ctx.reply("⚠️ Baseline not set yet. Baseline is only set at 6:00 AM IST or by admin /setbaseline.");
  }
  let out = `📊 Baseline Top 10 (day: ${persistence.baselineDate})\n`;
  persistence.coins.forEach((c, i) => {
    out += `${i + 1}. ${c.symbol} — $${c.price.toFixed(4)} (24h: ${c.change.toFixed(2)}%)\n`;
  });
  ctx.reply(out);
});

bot.command("profit", async (ctx) => {
  if (!persistence.baselineDate || persistence.coins.length === 0) {
    return ctx.reply("⚠️ Baseline not set yet.");
  }
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit: 100, convert: "USD" }
    });
    const now = res.data.data;
    let report = "📈 Profit since baseline:\n";
    const results = persistence.coins.map((base) => {
      const live = now.find((c) => c.symbol === base.symbol);
      if (!live) return null;
      const change = ((live.quote.USD.price - base.price) / base.price) * 100;
      return { symbol: base.symbol, base: base.price, now: live.quote.USD.price, change };
    }).filter(Boolean);

    results.sort((a, b) => b.change - a.change);
    results.forEach((r, i) => {
      report += `${i + 1}. ${r.symbol} → ${r.change.toFixed(2)}% (from $${r.base.toFixed(4)} → $${r.now.toFixed(4)})\n`;
    });
    ctx.reply(report);
  } catch (err) {
    log("❌ Error in /profit: " + err.message);
    ctx.reply("⚠️ Could not fetch profit data.");
  }
});

bot.command("alerts", (ctx) => {
  ctx.reply(`🔔 Alerts for baseline ${persistence.baselineDate || "N/A"}:\nNone`);
});

bot.command("setbaseline", async (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }
  await setBaseline();
  ctx.reply(`✅ Manual baseline set — ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }
  persistence.alertsBaseline = 0;
  savePersistence();
  ctx.reply("🧹 Alerts cleared for today.");
});

bot.command("logs", (ctx) => {
  if (ctx.from.id.toString() !== config.ADMIN_ID) {
    return ctx.reply("❌ Admin only.");
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const logFile = path.join(__dirname, "logs", `${today}.log`);
  if (!fs.existsSync(logFile)) {
    return ctx.reply("⚠️ No logs found for today.");
  }
  const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
  const last30 = lines.slice(-30).join("\n");
  ctx.replyWithMarkdownV2("📜 *Last 30 log entries:*\n```\n" + last30 + "\n```");
});

// -------------------- BASELINE LOGIC --------------------
async function setBaseline() {
  try {
    const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit: 50, convert: "USD" }
    });

    const coins = res.data.data;
    const sorted = coins.sort((a, b) => b.quote.USD.percent_change_24h - a.quote.USD.percent_change_24h);
    const top10 = sorted.slice(0, 10).map((c) => ({
      symbol: c.symbol,
      price: c.quote.USD.price,
      change: c.quote.USD.percent_change_24h
    }));

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    persistence.baselineDate = today;
    persistence.coins = top10;
    persistence.alertsBaseline = 0;
    savePersistence();

    log(`✅ Baseline set: ${today}`);
    if (persistence.savedChat) {
      let msg = `✅ *Baseline set (${today})*\nMonitoring top 10:\n`;
      top10.forEach((c, i) => {
        msg += `${i + 1}. ${c.symbol} - $${c.price.toFixed(2)} (24h: ${c.change.toFixed(2)}%)\n`;
      });
      bot.telegram.sendMessage(persistence.savedChat, msg, { parse_mode: "Markdown" });
    }
  } catch (err) {
    log("❌ Error setting baseline: " + err.message);
  }
}

// -------------------- SCHEDULERS --------------------
schedule.scheduleJob("0 6 * * *", () => { // 6:00 AM IST
  setBaseline();
});
