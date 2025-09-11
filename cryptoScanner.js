const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
app.use(express.json());

const baselineFile = path.join(__dirname, "baseline.json");

// --- File helpers ---
function loadBaseline() {
  if (fs.existsSync(baselineFile)) {
    return JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  }
  return {};
}

function saveBaseline(data) {
  fs.writeFileSync(baselineFile, JSON.stringify(data, null, 2));
}

let baselineData = loadBaseline();
let alertedCoins = {}; // to avoid spamming alerts

// --- Telegram helpers ---
async function sendMessage(text, markdown = false) {
  if (!config.BOT_TOKEN || !config.CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text,
      parse_mode: markdown ? "Markdown" : undefined,
    });
  } catch (err) {
    console.error("❌ Telegram sendMessage error:", err.response?.data || err.message);
  }
}

async function setWebhook() {
  if (!config.BOT_TOKEN || !config.BASE_URL) return;
  const webhookUrl = `${config.BASE_URL}/webhook`;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${config.BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    if (res.data.ok) console.log(`✅ Webhook set: ${webhookUrl}`);
  } catch (err) {
    console.error("❌ Error setting webhook:", err.message);
  }
}

// --- Telegram webhook handler ---
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(
      "👋 Welcome! You will now receive crypto scanner updates.\n\nUse:\n`/status` → Check scanner\n`/top10` → Show today’s baseline\n`/alerts` → See triggered alerts\n/help → Command list",
      true
    );
  } else if (text === "/status") {
    await sendMessage(
      `✅ Scanner is running.\n📅 Today: ${baselineData.date || "No baseline yet"}`,
      false
    );
  } else if (text === "/help") {
    await sendMessage(
      "📖 *Available Commands:*\n\n/start - Start updates\n/status - Scanner status\n/top10 - Show today’s baseline\n/alerts - Show today’s triggered alerts\n/help - Command list",
      true
    );
  } else if (text === "/top10") {
    if (!baselineData.top10) {
      await sendMessage("❌ No baseline set yet. Wait until 6 AM IST.");
    } else {
      let out = `📜 *Today's Baseline (6 AM ${baselineData.date})*\n`;
      baselineData.top10.forEach((c, i) => {
        const price = c.price ? `$${c.price.toFixed(2)}` : "N/A";
        const change =
          typeof c.change === "number" ? `${c.change.toFixed(2)}%` : "N/A";
        out += `${i + 1}. ${c.symbol} - ${price} (24h: ${change})\n`;
      });
      await sendMessage(out, true);
    }
  } else if (text === "/alerts") {
    if (!baselineData.top10) {
      await sendMessage("❌ No baseline set yet. Wait until 6 AM IST.");
    } else if (Object.keys(alertedCoins).length === 0) {
      await sendMessage("✅ No alerts have been triggered today.");
    } else {
      let out = `🚨 *Triggered Alerts (${baselineData.date})*\n`;
      Object.entries(alertedCoins).forEach(([symbol, info]) => {
        out += `- ${symbol}: Dropped ${info.drop}% at ${info.time}\n`;
      });
      await sendMessage(out, true);
    }
  } else {
    await sendMessage("⚠️ Unknown command. Type `/help` to see available commands.");
  }

  res.sendStatus(200);
});

// --- Market data fetcher ---
async function fetchTopCoins(limit = 50) {
  const res = await axios.get(
    "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
    {
      headers: { "X-CMC_PRO_API_KEY": config.CMC_API_KEY },
      params: { start: 1, limit, convert: "USD" },
    }
  );
  return res.data.data.map((c) => ({
    symbol: c.symbol,
    price: c.quote.USD.price,
    change: c.quote.USD.percent_change_24h,
  }));
}

// --- Scheduler ---
function scheduleTasks() {
  setInterval(async () => {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const hours = ist.getUTCHours();
    const minutes = ist.getUTCMinutes();

    // 6 AM IST baseline
    if (hours === 0 && minutes === 30) {
      try {
        const coins = await fetchTopCoins(50);
        const top10 = coins.sort((a, b) => b.change - a.change).slice(0, 10);
        baselineData = {
          date: ist.toISOString().split("T")[0],
          top10,
          baseline: Object.fromEntries(top10.map((c) => [c.symbol, c.price])),
        };
        saveBaseline(baselineData);
        alertedCoins = {}; // reset alerts

        let out = `✅ *Baseline set (6 AM IST ${baselineData.date})*\nMonitoring top 10:\n`;
        top10.forEach(
          (c, i) =>
            (out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(
              2
            )} (24h: ${c.change.toFixed(2)}%)\n`)
        );
        await sendMessage(out, true);
      } catch (err) {
        console.error("❌ Error setting baseline:", err.message);
      }
    }

    // Intraday monitoring
    if (baselineData.top10) {
      try {
        const coins = await fetchTopCoins(50);
        for (const b of baselineData.top10) {
          const live = coins.find((c) => c.symbol === b.symbol);
          if (!live) continue;
          const pctDrop = ((live.price - b.price) / b.price) * 100;
          if (pctDrop <= -10 && !alertedCoins[b.symbol]) {
            alertedCoins[b.symbol] = {
              drop: pctDrop.toFixed(2),
              time: ist.toLocaleTimeString("en-IN", {
                timeZone: "Asia/Kolkata",
              }),
            };
            const alert = `🚨 *ALERT*\n${b.symbol} dropped ${pctDrop.toFixed(
              2
            )}% from baseline.\n📉 Current: $${live.price.toFixed(
              2
            )}\n🕒 Time: ${alertedCoins[b.symbol].time}`;
            await sendMessage(alert, true);
          }
        }
      } catch (err) {
        console.error("❌ Error monitoring drops:", err.message);
      }
    }

    // 10 PM IST summary
    if (hours === 16 && minutes === 30 && baselineData.top10) {
      try {
        const coins = await fetchTopCoins(50);
        const summary = baselineData.top10
          .map((b) => {
            const live = coins.find((c) => c.symbol === b.symbol);
            if (!live) return null;
            const pct = ((live.price - b.price) / b.price) * 100;
            return { ...live, pct };
          })
          .filter(Boolean);

        const ranked = summary.sort((a, b) => b.pct - a.pct);
        let out = `📊 *Daily Summary (10 PM IST ${baselineData.date})*\nPerformance ranked best → worst:\n`;
        ranked.forEach(
          (c, i) =>
            (out += `${i + 1}. ${c.symbol} - $${c.price.toFixed(
              2
            )} | Change: ${c.pct.toFixed(2)}%\n`)
        );
        await sendMessage(out, true);
      } catch (err) {
        console.error("❌ Error sending daily summary:", err.message);
      }
    }
  }, 60 * 1000);
}

// --- Start server ---
app.listen(config.PORT, async () => {
  console.log(`🌍 Server running on port ${config.PORT}`);
  console.log("🔍 Scanner initialized");
  await setWebhook();
  scheduleTasks();
});
