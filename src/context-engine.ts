import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedMementoConfig } from "./config.js";
import { resolveMementoPaths } from "./paths.js";
import { resolveCurrentAgentId, resolveCurrentSessionKey } from "./agent-context.js";

const TOKEN_ESTIMATE_RATIO = 4;
const MAX_CHARS = 50_000 * TOKEN_ESTIMATE_RATIO;

const cachedObservationPromptSections = new Map<string, string[]>();

export function invalidateObservationPromptCache(agentId?: string): void {
  if (agentId) {
    for (const key of cachedObservationPromptSections.keys()) if (key.startsWith(`${agentId}::`)) cachedObservationPromptSections.delete(key);
    return;
  }
  cachedObservationPromptSections.clear();
}

function readObservationFile(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function registerContextEngine(api: OpenClawPluginApi, _config: ResolvedMementoConfig): void {
  api.registerMemoryPromptSection((params) => {
    const context = params as { agentId?: string; sessionKey?: string };
    const agentId = resolveCurrentAgentId(api, context);
    const sessionKey = resolveCurrentSessionKey(context);
    const cacheKey = `${agentId}::${sessionKey ?? "shared"}`;
    const cached = cachedObservationPromptSections.get(cacheKey);
    if (cached !== undefined) return cached;

    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const sharedRaw = readObservationFile(resolveMementoPaths(workspaceDir, agentId, { scope: "shared" }).observationsPath);
    const sessionRaw = sessionKey ? readObservationFile(resolveMementoPaths(workspaceDir, agentId, { scope: "session", sessionKey }).observationsPath) : "";
    const combined = [sharedRaw.trim() ? `<shared-observations>\n${sharedRaw}\n</shared-observations>` : "", sessionRaw.trim() ? `<session-observations>\n${sessionRaw}\n</session-observations>` : ""].filter(Boolean).join("\n\n");

    let section: string[];
    if (!combined.trim()) section = ["<!-- Memento: no observations yet -->"];
    else if (combined.length > MAX_CHARS) {
      api.logger.warn("Memento: observations.md exceeds 50,000-token soft limit, injecting truncated version");
      section = ["<memento-observations>", combined.slice(0, MAX_CHARS), "</memento-observations>"];
    } else section = ["<memento-observations>", combined, "</memento-observations>"];

    cachedObservationPromptSections.set(cacheKey, section);
    return section;
  });
}
