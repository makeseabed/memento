import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendLog(
  logPath: string,
  message: string,
  fileEnabled = true
): Promise<void> {
  if (!fileEnabled) return;

  try {
    await mkdir(dirname(logPath), { recursive: true });
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    await appendFile(logPath, `${ts} ${message}\n`, "utf8");
  } catch {
    // logging must never throw
  }
}
