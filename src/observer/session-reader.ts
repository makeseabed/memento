import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedMementoConfig } from "../config.js";
import { formatObserverTime } from "./date-format.js";

export interface SessionMessage {
  text: string;
  sessionFile: string;
  sessionKey: string;
}

export interface SessionReaderResult {
  messages: string[];
  sessionFiles: string[];
  sessionKeys: string[];
  detailedMessages: SessionMessage[];
}

export const UNRESOLVED_RECOVERY_SESSION_KEY = "__unresolved_recovery_session__";

export function stripChannelMetadata(text: string): string {
  const startPrefix = "<<<EXTERNAL_UNTRUSTED_CONTENT";
  const endPrefix = "<<<END_EXTERNAL_UNTRUSTED_CONTENT";
  const startIdx = text.indexOf(startPrefix);
  if (startIdx === -1) return text;
  const startTagEnd = text.indexOf(">>>", startIdx);
  if (startTagEnd === -1) return text;
  const endIdx = text.indexOf(endPrefix, startTagEnd);
  if (endIdx === -1 || endIdx <= startTagEnd) return text;
  const inner = text.slice(startTagEnd + 3, endIdx).trim();
  const cleaned = inner.replace(/^UNTRUSTED\s+\S+\s+message body\n?/i, "").trim();
  return cleaned.length > 0 ? cleaned : text;
}

const SELF_OUTPUT_PATTERN = /NO_OBSERVATIONS|OBSERVATIONS_ADDED|REFLECTION_COMPLETE|observer-agent|reflector-agent/i;

function isIncludedSession(sessionId: string, storeMap: Map<string, string>, agentId = "main"): boolean {
  const key = storeMap.get(sessionId);
  if (!key) return false;
  if (!key.startsWith("agent:")) return true;
  const parts = key.split(":");
  const [, sessionAgentId, sessionType] = parts;
  if (!sessionAgentId || sessionAgentId !== agentId) return false;
  return !["main", "cron", "subagent", "acp", "memento"].includes(sessionType ?? "");
}

interface JsonlEntry {
  timestamp?: string;
  message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
}

function extractText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
}

async function readSessionFile(filePath: string, sessionKey: string, cutoffTime: Date, maxLines: number): Promise<SessionMessage[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const tail = raw.trim().split("\n").filter(Boolean).slice(-maxLines);
    const messages: SessionMessage[] = [];
    for (const line of tail) {
      try {
        const entry: JsonlEntry = JSON.parse(line);
        if (!entry.timestamp || !entry.message?.role) continue;
        const ts = new Date(entry.timestamp);
        if (ts < cutoffTime) continue;
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = extractText(entry.message.content).trim();
        if (!text || text.length < 5) continue;
        if (text === "HEARTBEAT_OK" || text === "NO_REPLY" || text === "ANNOUNCE_SKIP") continue;
        if (SELF_OUTPUT_PATTERN.test(text)) continue;
        const who = role === "user" ? "USER" : "ASSISTANT";
        const timeStr = formatObserverTime(ts);
        const cleanText = stripChannelMetadata(text);
        messages.push({
          sessionFile: filePath,
          sessionKey,
          text: `[${timeStr}] [session=${sessionKey}] ${who}: ${cleanText.slice(0, 500)}`,
        });
      } catch {
        // skip malformed JSONL lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

export async function resolveSessionKeyForPath(sessionsDir: string, sessionPath: string): Promise<string | undefined> {
  try {
    const storeRaw = await readFile(join(sessionsDir, "sessions.json"), "utf8");
    const store = JSON.parse(storeRaw) as Record<string, { sessionId?: string }>;
    const sessionId = sessionPath.split("/").pop()?.replace(/\.jsonl$/, "");
    for (const [key, entry] of Object.entries(store)) {
      if (entry.sessionId === sessionId) return key;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export async function readRecentSessions(
  sessionsDir: string,
  config: ResolvedMementoConfig,
  opts: { lookbackMinutes: number; recoverSessionPath?: string; recoverSessionKey?: string; agentId?: string }
): Promise<SessionReaderResult> {
  const { maxSessions, maxLinesPerTranscript } = config.observer;
  const cutoffTime = new Date(Date.now() - opts.lookbackMinutes * 60 * 1000);

  if (opts.recoverSessionPath) {
    const sessionKey = opts.recoverSessionKey
      ?? (sessionsDir ? await resolveSessionKeyForPath(sessionsDir, opts.recoverSessionPath) : undefined)
      ?? UNRESOLVED_RECOVERY_SESSION_KEY;
    const detailedMessages = await readSessionFile(opts.recoverSessionPath, sessionKey, cutoffTime, maxLinesPerTranscript);
    return {
      detailedMessages,
      messages: detailedMessages.map((m) => m.text),
      sessionFiles: detailedMessages.length > 0 ? [opts.recoverSessionPath] : [],
      sessionKeys: detailedMessages.length > 0 && sessionKey !== UNRESOLVED_RECOVERY_SESSION_KEY ? [sessionKey] : [],
    };
  }

  const storeMap = new Map<string, string>();
  try {
    const storeRaw = await readFile(join(sessionsDir, "sessions.json"), "utf8");
    const store = JSON.parse(storeRaw) as Record<string, { sessionId?: string }>;
    for (const [key, entry] of Object.entries(store)) if (entry.sessionId) storeMap.set(entry.sessionId, key);
  } catch {
    // ignore
  }

  let files: Array<{ path: string; mtime: Date; sessionKey: string }> = [];
  try {
    const entries = await readdir(sessionsDir);
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -6);
      if (!isIncludedSession(sessionId, storeMap, opts.agentId)) continue;
      const sessionKey = storeMap.get(sessionId);
      if (!sessionKey) continue;
      const filePath = join(sessionsDir, name);
      try {
        const s = await stat(filePath);
        files.push({ path: filePath, mtime: s.mtime, sessionKey });
      } catch {
        // skip unreadable
      }
    }
  } catch {
    return { messages: [], sessionFiles: [], sessionKeys: [], detailedMessages: [] };
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  files = files.slice(0, maxSessions);

  const detailedMessages: SessionMessage[] = [];
  const sessionFiles: string[] = [];
  const sessionKeys = new Set<string>();

  for (const { path: filePath, sessionKey } of files) {
    const msgs = await readSessionFile(filePath, sessionKey, cutoffTime, maxLinesPerTranscript);
    if (msgs.length > 0) {
      detailedMessages.push(...msgs);
      sessionFiles.push(filePath);
      sessionKeys.add(sessionKey);
    }
  }

  return {
    detailedMessages,
    messages: detailedMessages.map((m) => m.text),
    sessionFiles,
    sessionKeys: [...sessionKeys],
  };
}
