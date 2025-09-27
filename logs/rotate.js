import fs from "fs";
import path from "path";

const logsDir = path.join(process.cwd(), "logs");

export function rotateLogs() {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({
      file: f,
      time: fs.statSync(path.join(logsDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  files.slice(7).forEach(({ file }) => {
    fs.unlinkSync(path.join(logsDir, file));
  });
}