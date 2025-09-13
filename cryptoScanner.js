// cryptoScanner.js (Webhook-only mode, Render-ready)

const express = require("express");
const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// === Load ENV from Render ===
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // e.g. https://crypto-scanner-jaez.onrender.com

if (!BOT_TOKEN || !RENDER_URL) {
  console.error("❌ TELEGRAM_TOKEN or RENDER_EXTERNAL_URL missing in environment");
  process.exit(1);
}

// === Setup bot ===
const bot = new Telegraf(BOT_TOKEN);

// === Basic command handlers ===
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome! You will receive crypto scanner updates here.\n\n" +
      "📌 Commands:\n" +
      "/status – scanner & baseline status\n" +
      "/top10 – show today's baseline\n" +
      "/profit – ranked % profit since baseline\n" +
      "/alerts – list current alerts\n" +
      "/setbaseline – (admin only)\n" +
      "/clearhistory – (admin only)"
  );
});

bot.command("status", (ctx) => {
  ctx.reply("✅ Scanner running.\n(Baseline check placeholder).");
});

bot.command("top10", (ctx) => {
  ctx.reply("📊 Top 10 coins (placeholder).");
});

bot.command("profit", (ctx) => {
  ctx.reply("📈 Profit report (placeholder).");
});

bot.command("alerts", (ctx) => {
  ctx.reply("🔔 Alerts report (placeholder).");
});

bot.command("setbaseline", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("❌ You are not allowed to use this command.");
  }
  ctx.reply("✅ Manual baseline set (placeholder).");
});

bot.command("clearhistory", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.reply("❌ You are not allowed to use this command.");
  }
  ctx.reply("🧹 Alerts cleared for today (placeholder).");
});

// === Express server with webhook ===
const app = express();

// attach webhook callback
app.use(bot.webhookCallback("/webhook"));

// set webhook when server starts
(async () => {
  try {
    const webhookUrl = `${RENDER_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set to ${webhookUrl}`);
  } catch (err) {
    console.error("❌ Error setting webhook:", err);
  }
})();

app.get("/", (req, res) => res.send("Crypto Scanner bot is live ✅"));

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});
