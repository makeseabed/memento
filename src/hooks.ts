import type { ResolvedMementoConfig } from "./config.js";
import { resolveMementoPaths } from "./paths.js";
import { FALLBACK_AGENT_ID, resolveAgentIdFromSessionKey, resolveCurrentAgentId } from "./agent-context.js";
import { runObserver } from "./observer/observer.js";
import { registerSessionRecovery } from "./session-recovery.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendLog } from "./utils/log.js";
import { invalidateObservationPromptCache } from "./context-engine.js";

// Module-level state for watcher hook
const agentTurnCounts = new Map<string, number>();
const seenTranscriptMessageIds = new Set<string>();

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    })
    .join("\n")
    .trim();
}

function isMeaningfulAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  if ((message as { role?: unknown }).role !== "assistant") return false;
  const text = extractTextFromMessage(message);
  if (!text) return false;
  return text !== "HEARTBEAT_OK" && text !== "NO_REPLY" && text !== "ANNOUNCE_SKIP";
}

async function triggerWatcherObserver(
  api: OpenClawPluginApi,
  config: ResolvedMementoConfig,
  agentId: string,
  logPath: string
): Promise<void> {
  try {
    const result = await runObserver(api, config, {
      agentId,
      triggerTag: "[watcher]",
    });
    await appendLog(
      logPath,
      `[watcher] complete — status=${result.status}, added=${result.observationsAdded}`,
      config.logging
    );
  } catch (err) {
    await appendLog(logPath, `[watcher] ERROR: observer run failed (${String(err)})`, config.logging);
  }
}

export function registerHooks(api: OpenClawPluginApi, config: ResolvedMementoConfig): void {
  api.on("session_start", (_event, ctx) => {
    const agentId = resolveCurrentAgentId(api, ctx);
    if (!agentTurnCounts.has(agentId)) {
      agentTurnCounts.set(agentId, 0);
    }
    invalidateObservationPromptCache(agentId);
  });

  // Layer 3: Pre-compaction hook (memoryFlush)
  api.on("before_compaction", async (_event, ctx) => {
    const agentId = resolveCurrentAgentId(api, ctx);
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const { logPath } = resolveMementoPaths(workspaceDir, agentId, { scope: "shared" });
    await appendLog(logPath, "[memoryFlush] before_compaction fired — starting flush", config.logging);
    try {
      const result = await runObserver(api, config, {
        agentId,
        flushMode: true,
        triggerTag: "[memoryFlush]",
      });
      await appendLog(
        logPath,
        `[memoryFlush] complete — status=${result.status}, added=${result.observationsAdded}`,
        config.logging
      );
    } catch (err) {
      await appendLog(logPath, `[memoryFlush] error: ${String(err)}`, config.logging);
    }
  });

  api.on("after_compaction", (_event, ctx) => {
    invalidateObservationPromptCache(resolveCurrentAgentId(api, ctx));
  });

  // Layer 2: Reactive watcher via transcript updates, counted from meaningful assistant replies.
  api.runtime.events.onSessionTranscriptUpdate?.((update) => {
    if (!isMeaningfulAssistantMessage(update.message)) return;

    const messageId = typeof update.messageId === "string" ? update.messageId.trim() : "";
    if (messageId) {
      if (seenTranscriptMessageIds.has(messageId)) return;
      seenTranscriptMessageIds.add(messageId);
    }

    const agentId = resolveAgentIdFromSessionKey(update.sessionKey) ?? FALLBACK_AGENT_ID;
    const nextTurnCount = (agentTurnCounts.get(agentId) ?? 0) + 1;
    agentTurnCounts.set(agentId, nextTurnCount);
    if (nextTurnCount < config.watcher.turnThreshold) return;

    agentTurnCounts.set(agentId, 0);

    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const { logPath } = resolveMementoPaths(workspaceDir, agentId, { scope: "shared" });
    void appendLog(logPath, `[watcher] transcript watcher triggered observer (${config.watcher.turnThreshold} replies)`, config.logging);

    void triggerWatcherObserver(api, config, agentId, logPath);
  });

  // Layer 4: Session recovery hook
  registerSessionRecovery(api, config);
}
