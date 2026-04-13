import { join } from "node:path";

export const MEMENTO_DIR = "memento";
export const DEFAULT_AGENT_ID = "main";
export const LAST_OBSERVED_AT_FILE = "last-observed-at";

export type ObservationScope = "shared" | "session";

export interface ObservationStoreRef {
  scope: ObservationScope;
  sessionKey?: string;
}

export const OBSERVATIONS_FILE = join(MEMENTO_DIR, "shared", "observations.md");
export const OBSERVATION_BACKUP_DIR = join(MEMENTO_DIR, "shared", "backups");
export const LOG_FILE = join(MEMENTO_DIR, "memento.log");
export const OBSERVER_STATE_FILE = join(MEMENTO_DIR, ".observer-state.json");

function sanitizeSessionSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function encodeSessionStoreKey(sessionKey: string): string {
  const raw = sessionKey.trim();
  if (!raw) return "unknown";

  const segments = raw
    .split(":")
    .map((segment) => sanitizeSessionSegment(segment))
    .filter(Boolean);

  if (segments.length > 0) return segments.join("-");
  return sanitizeSessionSegment(raw) || "unknown";
}

export function resolveObservationStoreDir(agentMementoDir: string, store: ObservationStoreRef = { scope: "shared" }): string {
  if (store.scope === "shared") return join(agentMementoDir, "shared");
  if (!store.sessionKey?.trim()) return join(agentMementoDir, "shared");
  return join(agentMementoDir, "sessions", encodeSessionStoreKey(store.sessionKey));
}

export function resolveMementoPaths(
  workspaceDir: string,
  _agentId = DEFAULT_AGENT_ID,
  store: ObservationStoreRef = { scope: "shared" }
) {
  const agentMementoDir = join(workspaceDir, MEMENTO_DIR);
  const storeDir = resolveObservationStoreDir(agentMementoDir, store);

  return {
    agentMementoDir,
    storeDir,
    observationsPath: join(storeDir, "observations.md"),
    backupDir: join(storeDir, "backups"),
    logPath: join(agentMementoDir, "memento.log"),
    observerStatePath: join(agentMementoDir, ".observer-state.json"),
    lastObservedAtPath: join(storeDir, LAST_OBSERVED_AT_FILE),
  };
}
