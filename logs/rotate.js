// logs/rotate.js
import fs from "fs";
import path from "path";

const LOG_DIR = path.resolve("logs");
const MAX_DAYS = 7;

function rotateLogs() {
  if (!fs.existsSync(LOG_DIR)) return;

  const files = fs.readdirSync(LOG_DIR)
    .map(f => ({
      file: f,
      time: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time); // newest first

  // Keep only the latest MAX_DAYS files
  const toDelete = files.slice(MAX_DAYS);

  toDelete.forEach(({ file }) => {
    const filePath = path.join(LOG_DIR, file);
    try {
      fs.unlinkSync(filePath);
      console.log(`[LOG ROTATE] Deleted old log: ${file}`);
    } catch (err) {
      console.error(`[LOG ROTATE] Failed to delete ${file}:`, err);
    }
  });
}

// Run rotation once at startup
rotateLogs();

export default rotateLogs;