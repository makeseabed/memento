import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveMementoPaths, type ObservationStoreRef } from "../paths.js";

const DEFAULT_LOOKBACK_HOURS = 2;

export async function readLastObservedAt(
  workspaceDir: string,
  agentId = "main",
  store: ObservationStoreRef = { scope: "shared" }
): Promise<Date> {
  const { lastObservedAtPath: filePath } = resolveMementoPaths(workspaceDir, agentId, store);
  try {
    const content = await readFile(filePath, "utf8");
    const date = new Date(content.trim());
    if (isNaN(date.getTime())) return new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
    return date;
  } catch {
    return new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);
  }
}

export async function writeLastObservedAt(
  workspaceDir: string,
  agentId = "main",
  store: ObservationStoreRef = { scope: "shared" }
): Promise<void> {
  const { lastObservedAtPath: filePath } = resolveMementoPaths(workspaceDir, agentId, store);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, new Date().toISOString(), "utf8");
}
