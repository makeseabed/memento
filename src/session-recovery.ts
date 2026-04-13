import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolvedMementoConfig } from "./config.js";
import { resolveMementoPaths } from "./paths.js";
import { resolveCurrentAgentId, resolveCurrentSessionKey } from "./agent-context.js";
import { computeHash, readObserverState } from "./observer/dedup.js";
import { readRecentSessions, resolveSessionKeyForPath } from "./observer/session-reader.js";
import { runObserver } from "./observer/observer.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendLog } from "./utils/log.js";

interface JsonlEntry {
  timestamp?: string;
  message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
}

function extractTextFromEntry(entry: JsonlEntry): string {
  const content = entry.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
}

type RecoveryContext = { agentId?: string; sessionKey?: string } | undefined;

type RecoveryEvent = {
  sessionFile?: string;
  previousSessionPath?: string;
  previousSession?: { path?: string };
  agentId?: string;
  sessionKey?: string;
} | undefined;

export async function handleSessionRecovery(api: OpenClawPluginApi, config: ResolvedMementoConfig, event: unknown, ctx?: RecoveryContext): Promise<void> {
  const typedEvent = event as RecoveryEvent;
  const context = { ...typedEvent, ...ctx };
  const agentId = resolveCurrentAgentId(api, context);
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
  const sessionsDir = dirname(api.runtime.agent.session.resolveStorePath(undefined, { agentId }));
  const sharedPaths = resolveMementoPaths(workspaceDir, agentId, { scope: "shared" });
  const sessionPath = typedEvent?.sessionFile ?? typedEvent?.previousSessionPath ?? typedEvent?.previousSession?.path;
  if (!sessionPath) {
    await appendLog(sharedPaths.logPath, "[session-recovery] no previous session path in event context — skipping", config.logging);
    return;
  }

  const runtimeSessionKey = resolveCurrentSessionKey(context);
  const recoverSessionKey = runtimeSessionKey ?? await resolveSessionKeyForPath(sessionsDir, sessionPath);
  const { messages } = await readRecentSessions(sessionsDir, config, {
    lookbackMinutes: config.memoryFlush.recoverLookbackHours * 60,
    recoverSessionPath: sessionPath,
    recoverSessionKey,
  });
  if (messages.length === 0) {
    await appendLog(sharedPaths.logPath, "[session-recovery] no extractable messages in session — skipping", config.logging);
    return;
  }

  const currentHash = computeHash(messages.join("\n"));
  const observerState = await readObserverState(sharedPaths.observerStatePath);
  const storedHash = observerState[sessionPath];
  if (storedHash === currentHash) {
    await appendLog(sharedPaths.logPath, `[session-recovery] session already observed (${currentHash.slice(0, 8)}) — skipping`, config.logging);
    return;
  }

  await appendLog(sharedPaths.logPath, `[session-recovery] unobserved session detected: ${sessionPath.split("/").pop() ?? sessionPath} (hash: ${currentHash.slice(0, 8)})`, config.logging);
  try {
    await runObserver(api, config, { agentId, recoverMode: true, recoverSessionPath: sessionPath, recoverSessionKey, triggerTag: "[session-recovery]" });
    await appendLog(sharedPaths.logPath, "[session-recovery] recover-mode observer completed successfully", config.logging);
  } catch (err) {
    await appendLog(sharedPaths.logPath, `[session-recovery] observer call failed — falling back to raw-text capture: ${String(err)}`, config.logging);
    await rawTextFallback(api, config, agentId, sessionPath, recoverSessionKey, sharedPaths.logPath);
  }
}

async function rawTextFallback(api: OpenClawPluginApi, config: ResolvedMementoConfig, agentId: string, sessionPath: string, sessionKey: string | undefined, logPath: string): Promise<void> {
  try {
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const { observationsPath } = resolveMementoPaths(workspaceDir, agentId, sessionKey ? { scope: "session", sessionKey } : { scope: "shared" });
    await mkdir(dirname(observationsPath), { recursive: true });
    const raw = await readFile(sessionPath, "utf8");
    const rawLines = raw.trim().split("\n").filter(Boolean).slice(-50);
    const lines: string[] = [];
    for (const line of rawLines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        const role = entry.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = extractTextFromEntry(entry).trim();
        if (!text || text === "HEARTBEAT_OK" || text === "NO_REPLY") continue;
        lines.push(`${role === "user" ? "USER" : "ASSISTANT"}: ${text.slice(0, 400)}`);
      } catch {}
    }
    if (lines.length > 0) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      await appendFile(observationsPath, `\n<!-- Session Recovery Capture: ${timestamp} -->\n${lines.join("\n")}\n`, "utf8");
      await appendLog(logPath, `[session-recovery] raw-text fallback: captured ${lines.length} messages`, config.logging);
    }
  } catch (fallbackErr) {
    await appendLog(logPath, `[session-recovery] raw-text fallback also failed: ${String(fallbackErr)}`, config.logging);
  }
}

export function registerSessionRecovery(api: OpenClawPluginApi, config: ResolvedMementoConfig): void {
  api.on("before_reset", (event: unknown, ctx?: RecoveryContext) => handleSessionRecovery(api, config, event, ctx));
}
