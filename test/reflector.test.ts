import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReflector, shouldReflect } from "../src/reflector/reflector.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULTS } from "../src/config.js";
import { LOG_FILE, OBSERVATION_BACKUP_DIR, OBSERVATIONS_FILE } from "../src/paths.js";

/** Generates a string with approximately N words */
function makeWordContent(wordCount: number): string {
  return Array.from({ length: wordCount }, (_, i) => `word${i}`).join(" ");
}

// Build a mock PluginApi for testing
function makeMockApi(opts: {
  workspaceDir: string;
  assistantResponse?: string;
  subagentError?: Error;
}): OpenClawPluginApi {
  const response = opts.assistantResponse ?? "Consolidated observations content";

  const subagentRun = opts.subagentError
    ? vi.fn().mockRejectedValue(opts.subagentError)
    : vi.fn().mockResolvedValue({ runId: "mock-run-id" });

  const waitForRun = vi.fn().mockResolvedValue(undefined);

  const getSessionMessages = opts.subagentError
    ? vi.fn().mockRejectedValue(opts.subagentError)
    : vi.fn().mockResolvedValue({
        messages: [
          { role: "user", content: "mock prompt" },
          { role: "assistant", content: response },
        ],
      });

  return {
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      agent: {
        session: {
          resolveStorePath: () => opts.workspaceDir,
        },
        resolveAgentWorkspaceDir: () => opts.workspaceDir,
        resolveAgentDir: () => opts.workspaceDir,
        runEmbeddedPiAgent: opts.subagentError
          ? vi.fn().mockRejectedValue(opts.subagentError)
          : vi.fn().mockResolvedValue({
              payloads: [{ text: response }],
              meta: {},
            }),
      },
      subagent: {
        run: subagentRun,
        waitForRun,
        getSessionMessages,
        deleteSession: vi.fn(),
      },
      system: {
        runCommandWithTimeout: () =>
          Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      },
      events: {
        onSessionTranscriptUpdate: () => undefined,
      },
    },
    on: vi.fn(),
    registerHook: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("shouldReflect", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-reflect-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when file does not exist", async () => {
    const result = await shouldReflect(join(tmpDir, "missing.md"), 100);
    expect(result).toBe(false);
  });

  it("returns false when word count is below threshold", async () => {
    const path = join(tmpDir, "observations.md");
    await writeFile(path, makeWordContent(50), "utf8");
    expect(await shouldReflect(path, 100)).toBe(false);
  });

  it("returns true when word count equals threshold", async () => {
    const path = join(tmpDir, "observations.md");
    await writeFile(path, makeWordContent(100), "utf8");
    expect(await shouldReflect(path, 100)).toBe(true);
  });

  it("returns true when word count exceeds threshold", async () => {
    const path = join(tmpDir, "observations.md");
    await writeFile(path, makeWordContent(200), "utf8");
    expect(await shouldReflect(path, 100)).toBe(true);
  });
});

describe("runReflector", () => {
  let tmpDir: string;
  let observationsPath: string;
  let backupDir: string;

  const config = { ...DEFAULTS, logging: true };

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-reflector-test-${Date.now()}`);
    await mkdir(join(tmpDir, "memento", "shared"), { recursive: true });
    await mkdir(join(tmpDir, "memento", "logs"), { recursive: true });
    observationsPath = join(tmpDir, OBSERVATIONS_FILE);
    backupDir = join(tmpDir, OBSERVATION_BACKUP_DIR);

  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns skipped_no_file when observations.md does not exist", async () => {
    const api = makeMockApi({ workspaceDir: tmpDir });
    const result = await runReflector(api, config);
    expect(result.status).toBe("skipped_no_file");
  });

  it("uses runEmbeddedPiAgent for model execution", async () => {
    const inputContent = makeWordContent(200);
    const consolidatedResponse = makeWordContent(80);
    await writeFile(observationsPath, inputContent, "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: consolidatedResponse });
    await runReflector(api, config);

    expect(api.runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledOnce();
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("consolidates observations and writes shorter output", async () => {
    const inputContent = makeWordContent(200);
    const consolidatedResponse = makeWordContent(80);
    await writeFile(observationsPath, inputContent, "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: consolidatedResponse });

    const result = await runReflector(api, config);
    expect(result.status).toBe("reflected");
    expect(result.inputWords).toBe(200);
    expect(result.outputWords).toBeDefined();
    expect(result.outputWords!).toBeLessThan(200);
  });

  it("written output contains consolidation header", async () => {
    const consolidatedResponse = makeWordContent(80);
    await writeFile(observationsPath, makeWordContent(200), "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: consolidatedResponse });

    await runReflector(api, config);
    const written = await readFile(observationsPath, "utf8");
    expect(written).toContain("# Observations Log");
    // removed: header no longer includes "Consolidated by Reflector"
    expect(written).toContain(consolidatedResponse);
  });

  it("creates a backup before writing", async () => {
    const consolidatedResponse = makeWordContent(80);
    await writeFile(observationsPath, makeWordContent(200), "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: consolidatedResponse });

    const result = await runReflector(api, config);
    expect(result.backupPath).toBeDefined();

    const { readdir } = await import("node:fs/promises");
    const backups = await readdir(backupDir);
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0]).toMatch(/^observations-.*\.md$/);
  });

  it("rejects and restores when output word count >= input word count", async () => {
    const inputContent = makeWordContent(100);
    const expandedResponse = makeWordContent(100);
    await writeFile(observationsPath, inputContent, "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: expandedResponse });

    const result = await runReflector(api, config);
    expect(result.status).toBe("sanity_check_failed");

    const restored = await readFile(observationsPath, "utf8");
    expect(restored).toBe(inputContent);
  });

  it("rejects when output is larger than input", async () => {
    const inputContent = makeWordContent(100);
    const expandedResponse = makeWordContent(150);
    await writeFile(observationsPath, inputContent, "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: expandedResponse });

    const result = await runReflector(api, config);
    expect(result.status).toBe("sanity_check_failed");
    expect(result.outputWords).toBeGreaterThan(result.inputWords!);
  });

  it("returns error and does not overwrite observations when model call fails", async () => {
    const inputContent = makeWordContent(200);
    await writeFile(observationsPath, inputContent, "utf8");

    const api = makeMockApi({
      workspaceDir: tmpDir,
      subagentError: new Error("API timeout"),
    });

    const result = await runReflector(api, config);
    expect(result.status).toBe("error");

    const stillOriginal = await readFile(observationsPath, "utf8");
    expect(stillOriginal).toBe(inputContent);
  });

  it("logs run result to memento.log", async () => {
    const consolidatedResponse = makeWordContent(80);
    await writeFile(observationsPath, makeWordContent(200), "utf8");

    const api = makeMockApi({ workspaceDir: tmpDir, assistantResponse: consolidatedResponse });

    await runReflector(api, config);

    const log = await readFile(join(tmpDir, LOG_FILE), "utf8");
    expect(log).toContain("[reflector]");
  });
});
