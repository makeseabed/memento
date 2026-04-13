import { readFile, writeFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ResolvedMementoConfig } from "../config.js";
import { resolveMementoPaths, type ObservationStoreRef } from "../paths.js";
import { resolveCurrentAgentId } from "../agent-context.js";
import { appendLog } from "../utils/log.js";
import { backupObservations } from "./backup.js";
import { REFLECTOR_SYSTEM_PROMPT, buildReflectorUserPrompt } from "./prompts.js";
import { runModelViaEmbeddedAgent } from "../embedded-agent.js";

export { shouldReflect } from "../utils/word-count.js";

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function callReflectorModel(api: OpenClawPluginApi, systemPrompt: string, userPrompt: string, config: ResolvedMementoConfig): Promise<string> {
  return runModelViaEmbeddedAgent(api, {
    agentId: resolveCurrentAgentId(api),
    prefix: "reflector",
    instructionsTag: "reflector-instructions",
    systemPrompt,
    userPrompt,
    modelString: config.reflector.model,
  });
}

async function callReflectorModelForAgent(
  api: OpenClawPluginApi,
  agentId: string,
  systemPrompt: string,
  userPrompt: string,
  config: ResolvedMementoConfig
): Promise<string> {
  return runModelViaEmbeddedAgent(api, {
    agentId,
    prefix: "reflector",
    instructionsTag: "reflector-instructions",
    systemPrompt,
    userPrompt,
    modelString: config.reflector.model,
  });
}

export interface ReflectorResult {
  status: "reflected" | "skipped_no_file" | "sanity_check_failed" | "error";
  inputWords?: number;
  outputWords?: number;
  backupPath?: string;
}

export async function runReflector(
  api: OpenClawPluginApi,
  config: ResolvedMementoConfig,
  store: ObservationStoreRef = { scope: "shared" },
  requestedAgentId?: string
): Promise<ReflectorResult> {
  const agentId = requestedAgentId ?? resolveCurrentAgentId(api);
  const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
  const { observationsPath, backupDir, logPath } = resolveMementoPaths(workspaceDir, agentId, store);

  let inputContent: string;
  try {
    inputContent = await readFile(observationsPath, "utf8");
  } catch {
    await appendLog(logPath, "[reflector] SKIPPED_NO_FILE: observations.md not found", config.logging);
    return { status: "skipped_no_file" };
  }

  const inputWords = countWords(inputContent);
  await appendLog(logPath, `[reflector] starting: ${inputWords} words`, config.logging);
  const backupPath = await backupObservations(observationsPath, backupDir, config.reflector.backupRetentionCount);
  await appendLog(logPath, `[reflector] backed up to ${backupPath}`, config.logging);

  let reflected: string;
  try {
    reflected = await callReflectorModelForAgent(
      api,
      agentId,
      REFLECTOR_SYSTEM_PROMPT,
      buildReflectorUserPrompt(inputContent, new Date()),
      config
    );
  } catch (err) {
    await appendLog(logPath, `[reflector] ERROR: model call failed — ${String(err)}`, config.logging);
    return { status: "error", inputWords, backupPath };
  }

  const outputWords = countWords(reflected);
  if (outputWords >= inputWords) {
    await appendLog(logPath, `[reflector] SANITY_CHECK_FAILED: output (${outputWords} words) >= input (${inputWords} words) — restoring backup`, config.logging);
    try {
      await writeFile(observationsPath, await readFile(backupPath, "utf8"), "utf8");
    } catch (restoreErr) {
      await appendLog(logPath, `[reflector] ERROR: restore failed — ${String(restoreErr)}`, config.logging);
    }
    return { status: "sanity_check_failed", inputWords, outputWords, backupPath };
  }

  const today = new Date().toISOString().split("T")[0];
  const header = `# Observations Log\n\nLast reflection: ${today}\n\n---\n\n`;
  await writeFile(observationsPath, header + reflected + "\n", "utf8");
  const reduction = Math.round(((inputWords - outputWords) / inputWords) * 100);
  await appendLog(logPath, `[reflector] REFLECTED: ${inputWords} → ${outputWords} words (${reduction}% reduction)`, config.logging);
  return { status: "reflected", inputWords, outputWords, backupPath };
}
