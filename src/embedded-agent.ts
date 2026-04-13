import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveCurrentAgentId } from "./agent-context.js";

function shouldRetryWithoutOverride(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "model.request",
    "missing scopes",
    "insufficient scope",
    "unauthorized",
    "not authorized",
    "forbidden",
    "provider/model overrides are not authorized",
    "model override is not authorized",
    "unknown model",
    "model not found",
    "invalid model",
    "not available",
    "not supported",
    "401",
    "403",
  ].some((signal) => normalized.includes(signal));
}

function collectText(payloads: Array<{ text?: string } | undefined> | undefined): string {
  return (payloads ?? [])
    .map((payload) => payload?.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function runModelViaEmbeddedAgent(
  api: OpenClawPluginApi,
  opts: {
    agentId?: string;
    prefix: "observer" | "reflector";
    instructionsTag: string;
    systemPrompt: string;
    userPrompt: string;
    modelString?: string;
  }
): Promise<string> {
  const agentId = opts.agentId ?? resolveCurrentAgentId(api);
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
  const agentDir = api.runtime.agent.resolveAgentDir(api.config, agentId);
  const fullPrompt = `<${opts.instructionsTag}>\n${opts.systemPrompt}\n</${opts.instructionsTag}>\n\n${opts.userPrompt}`;
  const slashIdx = opts.modelString?.indexOf("/") ?? -1;
  const provider = slashIdx !== -1 && opts.modelString ? opts.modelString.slice(0, slashIdx) : undefined;
  const model = slashIdx !== -1 && opts.modelString ? opts.modelString.slice(slashIdx + 1) : opts.modelString;

  const invoke = async (attempt: number, providerOverride?: string, modelOverride?: string): Promise<string> => {
    const tempDir = await mkdtemp(join(tmpdir(), `memento-${opts.prefix}-`));
    try {
      const sessionId = `memento:${opts.prefix}:${randomUUID()}`;
      const result = await api.runtime.agent.runEmbeddedPiAgent({
        sessionId,
        sessionKey: sessionId,
        sessionFile: join(tempDir, "session.jsonl"),
        workspaceDir,
        agentDir,
        config: api.config,
        prompt: fullPrompt,
        provider: providerOverride,
        model: modelOverride,
        timeoutMs: 60_000,
        runId: `memento:${opts.prefix}:${attempt}:${randomUUID()}`,
        disableTools: true,
      });
      const text = collectText(result.payloads);
      if (!text) {
        const errorMessage = result.meta.error?.message;
        throw new Error(errorMessage ? `Empty response: ${errorMessage}` : "Empty response");
      }
      return text;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };

  try {
    return await invoke(0, provider, model);
  } catch (err) {
    if (model && shouldRetryWithoutOverride(String(err))) {
      return await invoke(1, undefined, undefined);
    }
    throw err;
  }
}
