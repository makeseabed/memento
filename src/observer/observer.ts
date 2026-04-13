import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedMementoConfig } from "../config.js";
import { resolveMementoPaths, type ObservationStoreRef, encodeSessionStoreKey } from "../paths.js";
import { resolveCurrentAgentId } from "../agent-context.js";
import { appendLog } from "../utils/log.js";
import { readRecentSessions, UNRESOLVED_RECOVERY_SESSION_KEY } from "./session-reader.js";
import { checkPreLLMDedup, readObserverState, writeObserverState, buildExistingFingerprints, deduplicateObservations, type ObserverState } from "./dedup.js";
import { OBSERVER_SYSTEM_PROMPT, buildObserverUserPrompt } from "./prompts.js";
import { runReflector } from "../reflector/reflector.js";
import { shouldReflect as shouldReflectShared } from "../utils/word-count.js";
import { readLastObservedAt, writeLastObservedAt } from "../utils/cursor.js";
import { runModelViaEmbeddedAgent } from "../embedded-agent.js";
import { formatObserverDate } from "./date-format.js";

export { shouldReflect } from "../utils/word-count.js";

const runningObservers = new Set<string>();
const BULLET_RE = /^\s*-\s*[🔴🟡🟢]/u;

export interface ObserverOpts {
  agentId?: string;
  flushMode?: boolean;
  recoverMode?: boolean;
  recoverSessionPath?: string;
  recoverSessionKey?: string;
  triggerTag?: string;
}

export interface ObserverResult {
  status: "added" | "no_observations" | "skipped_dedup" | "skipped_locked" | "error";
  observationsAdded: number;
  sessionsScanned: number;
}

async function getExistingObservationsContext(observationsPath: string, n: number): Promise<string> {
  try {
    const content = await readFile(observationsPath, "utf8");
    return content.split("\n").filter((line) => BULLET_RE.test(line)).slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function getExistingObservationsContent(observationsPath: string): Promise<string> {
  try {
    return await readFile(observationsPath, "utf8");
  } catch {
    return "";
  }
}

async function appendObservations(observationsPath: string, content: string): Promise<void> {
  await mkdir(dirname(observationsPath), { recursive: true });
  let existing = "";
  try { existing = await readFile(observationsPath, "utf8"); } catch {}
  if (!existing) await writeFile(observationsPath, "# Observations\n\n", "utf8");
  const cleaned = content.split("\n")
    .filter((line) => !/^Date:\s*\d{4}-\d{2}-\d{2}/.test(line.trim()))
    .filter((line) => !/^\*\*\d{4}-\d{2}-\d{2}\*\*/.test(line.trim()))
    .join("\n")
    .trim();
  if (!cleaned) return;
  const todayHeader = `## ${formatObserverDate(new Date())}`;
  const needsHeader = !existing.includes(todayHeader);
  await appendFile(observationsPath, `${needsHeader ? `\n${todayHeader}\n\n` : "\n"}${cleaned}\n`, "utf8");
}

async function callObserverModel(api: OpenClawPluginApi, systemPrompt: string, userPrompt: string, config: ResolvedMementoConfig): Promise<string> {
  return runModelViaEmbeddedAgent(api, {
    prefix: "observer",
    instructionsTag: "observer-instructions",
    systemPrompt,
    userPrompt,
    modelString: config.observer.model,
  });
}

function parseStoreRef(line: string): ObservationStoreRef {
  const scopeMatch = line.match(/dc:scope=(shared|session)\b/);
  const sessionMatch = line.match(/dc:session=([^\s>]+)/);
  const sessionKey = sessionMatch?.[1] ? decodeURIComponent(sessionMatch[1]) : undefined;

  const isSessionScoped = scopeMatch?.[1] === "session" || (!!sessionKey && !scopeMatch);
  if (!isSessionScoped) return { scope: "shared" };
  if (!sessionKey || sessionKey === UNRESOLVED_RECOVERY_SESSION_KEY) return { scope: "shared" };
  return { scope: "session", sessionKey };
}

function splitObservationsByStore(output: string): Map<string, { store: ObservationStoreRef; content: string }> {
  const buckets = new Map<string, { store: ObservationStoreRef; lines: string[] }>();
  let currentDateLine: string | undefined;
  for (const line of output.split("\n")) {
    if (/^Date:\s*\d{4}-\d{2}-\d{2}/.test(line.trim())) {
      currentDateLine = line.trim();
      continue;
    }
    if (!BULLET_RE.test(line)) continue;
    const store = parseStoreRef(line);
    const key = store.scope === "shared" ? "shared" : `session:${encodeSessionStoreKey(store.sessionKey)}`;
    const bucket = buckets.get(key) ?? { store, lines: [] };
    if (currentDateLine && bucket.lines.at(-1) !== currentDateLine) bucket.lines.push(currentDateLine);
    bucket.lines.push(line);
    buckets.set(key, bucket);
  }
  return new Map([...buckets.entries()].map(([key, value]) => [key, { store: value.store, content: value.lines.join("\n").trim() }]));
}

function buildPromptContext(contexts: Array<{ label: string; content: string }>): string {
  return contexts.filter((c) => c.content.trim()).map((c) => `### ${c.label}\n${c.content}`).join("\n\n");
}

export async function runObserver(api: OpenClawPluginApi, config: ResolvedMementoConfig, opts: ObserverOpts = {}): Promise<ObserverResult> {
  const { agentId: requestedAgentId, flushMode = false, recoverMode = false, recoverSessionPath, recoverSessionKey, triggerTag = "[cron]" } = opts;
  const agentId = requestedAgentId ?? resolveCurrentAgentId(api);
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
  const storePath = api.runtime.agent.session.resolveStorePath(undefined, { agentId });
  const sessionsDir = dirname(storePath);
  const sharedPaths = resolveMementoPaths(workspaceDir, agentId, { scope: "shared" });
  const lockKey = `observer:${agentId}`;
  if (runningObservers.has(lockKey)) return { status: "skipped_locked", observationsAdded: 0, sessionsScanned: 0 };
  runningObservers.add(lockKey);

  try {
    let lookbackMinutes: number;
    if (flushMode) lookbackMinutes = config.memoryFlush.flushLookbackHours * 60;
    else if (recoverMode) lookbackMinutes = config.memoryFlush.recoverLookbackHours * 60;
    else lookbackMinutes = Math.ceil((Date.now() - (await readLastObservedAt(workspaceDir, agentId, { scope: "shared" })).getTime()) / 60_000);

    const { messages, sessionFiles, sessionKeys } = await readRecentSessions(sessionsDir, config, {
      agentId,
      lookbackMinutes,
      recoverSessionPath: recoverMode ? recoverSessionPath : undefined,
      recoverSessionKey,
    });

    await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_TRIGGERED: ${sessionFiles.length} sessions, ${messages.length} messages`, config.logging);
    if (messages.length < 2) {
      await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_NO_ADDITIONS: only ${messages.length} messages found`, config.logging);
      if (!flushMode && !recoverMode) await writeLastObservedAt(workspaceDir, agentId, { scope: "shared" });
      return { status: "no_observations", observationsAdded: 0, sessionsScanned: sessionFiles.length };
    }

    let observerState: ObserverState = {};
    let hashForState = "";
    let compositeKeyForState = "";
    if (!flushMode && !recoverMode) {
      observerState = await readObserverState(sharedPaths.observerStatePath);
      const dedupResult = checkPreLLMDedup(messages, sessionFiles, observerState);
      hashForState = dedupResult.hash;
      compositeKeyForState = dedupResult.compositeKey;
      if (!dedupResult.changed) {
        await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_NO_ADDITIONS: content unchanged (${dedupResult.hash.slice(0, 8)})`, config.logging);
        await writeLastObservedAt(workspaceDir, agentId, { scope: "shared" });
        return { status: "skipped_dedup", observationsAdded: 0, sessionsScanned: sessionFiles.length };
      }
    }

    const contextSections = [{ label: "Shared", content: await getExistingObservationsContext(sharedPaths.observationsPath, config.observer.existingObservationsContext) }];
    for (const sessionKey of sessionKeys) {
      const sessionPaths = resolveMementoPaths(workspaceDir, agentId, { scope: "session", sessionKey });
      contextSections.push({ label: `Session ${sessionKey}`, content: await getExistingObservationsContext(sessionPaths.observationsPath, config.observer.existingObservationsContext) });
    }
    const userPrompt = buildObserverUserPrompt(messages, buildPromptContext(contextSections), new Date());

    let llmOutput: string;
    try {
      llmOutput = await callObserverModel(api, OBSERVER_SYSTEM_PROMPT, userPrompt, config);
    } catch (err) {
      await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_FAILED: model call failed (${String(err)})`, config.logging);
      return { status: "error", observationsAdded: 0, sessionsScanned: sessionFiles.length };
    }

    if (!llmOutput || /NO_OBSERVATIONS/i.test(llmOutput)) {
      await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_NO_ADDITIONS: LLM found nothing notable`, config.logging);
      if (hashForState && compositeKeyForState) {
        observerState[compositeKeyForState] = hashForState;
        await writeObserverState(sharedPaths.observerStatePath, observerState);
      }
      if (!flushMode && !recoverMode) await writeLastObservedAt(workspaceDir, agentId, { scope: "shared" });
      return { status: "no_observations", observationsAdded: 0, sessionsScanned: sessionFiles.length };
    }

    const scoped = splitObservationsByStore(llmOutput);
    let totalBullets = 0;
    let wroteAny = false;

    for (const { store, content } of scoped.values()) {
      const paths = resolveMementoPaths(workspaceDir, agentId, store);
      const existingContent = await getExistingObservationsContent(paths.observationsPath);
      const { dedupedOutput, allDeduped } = deduplicateObservations(content, buildExistingFingerprints(existingContent));
      if (allDeduped || !dedupedOutput.trim()) continue;
      await appendObservations(paths.observationsPath, dedupedOutput);
      await writeLastObservedAt(workspaceDir, agentId, store);
      const bulletCount = (dedupedOutput.match(/^\s*-\s*[🔴🟡🟢]/gmu) ?? []).length;
      totalBullets += bulletCount;
      wroteAny = true;
      const needsReflect = await shouldReflectShared(paths.observationsPath, config.reflector.triggerWordThreshold);
      if (needsReflect) {
        await appendLog(paths.logPath, `${triggerTag} REFLECT_TRIGGERED: word count exceeds threshold`, config.logging);
        runReflector(api, config, store, agentId).catch((err: unknown) => appendLog(paths.logPath, `${triggerTag} REFLECT_ERROR: ${String(err)}`, config.logging).catch(() => {}));
      }
    }

    if (!wroteAny) {
      await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_NO_ADDITIONS: all observations were duplicates (after-LLM dedup)`, config.logging);
      if (hashForState && compositeKeyForState) {
        observerState[compositeKeyForState] = hashForState;
        await writeObserverState(sharedPaths.observerStatePath, observerState);
      }
      if (!flushMode && !recoverMode) await writeLastObservedAt(workspaceDir, agentId, { scope: "shared" });
      return { status: "no_observations", observationsAdded: 0, sessionsScanned: sessionFiles.length };
    }

    if (hashForState && compositeKeyForState) {
      observerState[compositeKeyForState] = hashForState;
      await writeObserverState(sharedPaths.observerStatePath, observerState);
    }
    if (!flushMode && !recoverMode) await writeLastObservedAt(workspaceDir, agentId, { scope: "shared" });
    await appendLog(sharedPaths.logPath, `${triggerTag} OBSERVER_ADDED: ${totalBullets} bullets, ${sessionFiles.length} sessions scanned`, config.logging);
    return { status: "added", observationsAdded: totalBullets, sessionsScanned: sessionFiles.length };
  } finally {
    runningObservers.delete(lockKey);
  }
}
