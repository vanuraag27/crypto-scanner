import fs from "fs";
import path from "path";

export function rotateLogs(logDir = path.join(process.cwd(), "logs")) {
  try {
    if (!fs.existsSync(logDir)) return;
    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"));
    const keep = 7;
    const byTime = files.map(f => {
      const p = path.join(logDir, f);
      return { f, t: fs.statSync(p).mtime.getTime() };
    }).sort((a,b) => b.t - a.t);

    const toDelete = byTime.slice(keep);
    toDelete.forEach(o => {
      try { fs.unlinkSync(path.join(logDir, o.f)); } catch(e){}
    });
  } catch(e){}
}