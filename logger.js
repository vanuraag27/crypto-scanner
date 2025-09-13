// logger.js
const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function getLogFile() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return path.join(logDir, `${today}.log`);
}

function log(message) {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${timestamp}] ${message}`;
  console.log(line); // still log important events to Render
  fs.appendFileSync(getLogFile(), line + "\n", "utf-8");
}

module.exports = { log };
