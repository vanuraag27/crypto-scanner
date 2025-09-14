// logger.js
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function todayFile() {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  return path.join(LOG_DIR, `${d}.log`);
}

function timestamp() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function write(line) {
  const out = `[${timestamp()}] ${line}`;
  console.log(out);
  try {
    fs.appendFileSync(todayFile(), out + "\n", "utf8");
  } catch (e) {
    console.error("logger write error:", e.message);
  }
}

module.exports = {
  write,
  todayFilePath: todayFile
};