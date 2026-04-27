import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runObserver, shouldReflect } from "../src/observer/observer.js";
import { UNRESOLVED_RECOVERY_SESSION_KEY } from "../src/observer/session-reader.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULTS } from "../src/config.js";

// Build a mock PluginApi for testing
function makeMockApi(opts: {
  workspaceDir: string;
  sessionsDir: string;
  assistantResponse?: string;
  subagentError?: Error;
}): OpenClawPluginApi {
  const response = opts.assistantResponse ?? `Date: 2026-04-01\n- 🔴 Test observation <!-- dc:type=rule dc:importance=7.0 dc:date=2026-04-01 dc:session=user:chat:main -->`;

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
          resolveStorePath: () => join(opts.sessionsDir, "sessions.json"),
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
          Promise.resolve({ stdout: "[]", stderr: "", exitCode: 0 }),
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

function makeSessionEntry(role: string, text: string, minutesAgo: number): string {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return JSON.stringify({ timestamp: ts, message: { role, content: text } });
}

describe("shouldReflect", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-obs-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when file does not exist", async () => {
    const result = await shouldReflect(join(tmpDir, "missing.md"), 1000);
    expect(result).toBe(false);
  });

  it("returns false when word count is below threshold", async () => {
    await writeFile(join(tmpDir, "obs.md"), "short file with few words", "utf8");
    const result = await shouldReflect(join(tmpDir, "obs.md"), 1000);
    expect(result).toBe(false);
  });

  it("returns true when word count exceeds threshold", async () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    await writeFile(join(tmpDir, "obs.md"), words, "utf8");
    const result = await shouldReflect(join(tmpDir, "obs.md"), 50);
    expect(result).toBe(true);
  });
});

describe("runObserver", () => {
  let workspaceDir: string;
  let sessionsDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-run-test-${Date.now()}`);
    workspaceDir = join(tmpDir, "workspace");
    sessionsDir = join(tmpDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(join(workspaceDir, "memento", "logs"), { recursive: true });
    await mkdir(join(workspaceDir, "memento", "shared"), { recursive: true });
    // Write sessions.json so "main.jsonl" passes the store-based channel filter
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({ "user:chat:main": { sessionId: "main" } }),
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns no_observations when sessions directory is empty", async () => {
    const api = makeMockApi({ workspaceDir, sessionsDir });
    const result = await runObserver(api, DEFAULTS);
    expect(result.status).toBe("no_observations");
    expect(result.sessionsScanned).toBe(0);
  });

  it("uses runEmbeddedPiAgent for model execution", async () => {
    const lines = [
      makeSessionEntry("user", "Hello world", 5),
      makeSessionEntry("assistant", "Hi there!", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });
    await runObserver(api, DEFAULTS);

    expect(api.runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledOnce();
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("returns no_observations when LLM returns NO_OBSERVATIONS", async () => {
    const lines = [
      makeSessionEntry("user", "Hello world", 5),
      makeSessionEntry("assistant", "Hi there!", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: "NO_OBSERVATIONS" });
    const result = await runObserver(api, {
      ...DEFAULTS,
      logging: true,
    });
    expect(result.status).toBe("no_observations");

    const logFile = join(workspaceDir, "memento", "memento.log");
    const logContent = await readFile(logFile, "utf8");
    expect(logContent).toContain("OBSERVER_TRIGGERED");
    expect(logContent).toContain("OBSERVER_NO_ADDITIONS: LLM found nothing notable");
  });

  it("appends observations to file on success", async () => {
    const lines = [
      makeSessionEntry("user", "I decided to use TypeScript for this project", 5),
      makeSessionEntry("assistant", "Great choice! TypeScript adds type safety.", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });
    const result = await runObserver(api, DEFAULTS);
    expect(result.status).toBe("added");
    expect(result.observationsAdded).toBeGreaterThan(0);

    const obsFile = join(workspaceDir, "memento", "shared", "observations.md");
    const content = await readFile(obsFile, "utf8");
    expect(content).toMatch(/🔴/);
  });

  it("splits shared and session-scoped observations into separate stores", async () => {
    const lines = [
      makeSessionEntry("user", "Remember this globally and only for this chat", 5),
      makeSessionEntry("assistant", "Understood", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const response = [
      "Date: 2026-04-01",
      "- 🔴 Shared observation <!-- dc:type=rule dc:importance=7.0 dc:date=2026-04-01 dc:session=user:chat:main -->",
      "- 🟡 Session observation <!-- dc:type=context dc:importance=3.0 dc:date=2026-04-01 dc:session=user:chat:main -->",
    ].join("\n");
    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: response });

    const result = await runObserver(api, DEFAULTS);
    expect(result.status).toBe("added");
    expect(result.observationsAdded).toBe(2);

    await expect(
      readFile(join(workspaceDir, "memento", "shared", "observations.md"), "utf8")
    ).resolves.toContain("Shared observation");
    await expect(
      readFile(join(workspaceDir, "memento", "sessions", "user-chat-main", "observations.md"), "utf8")
    ).resolves.toContain("Session observation");
  });

  it("routes session observations to the tagged session when multiple sessions are scanned", async () => {
    const mainLines = [
      makeSessionEntry("user", "Main session message", 5),
      makeSessionEntry("assistant", "Main session reply", 5),
    ].join("\n");
    const altLines = [
      makeSessionEntry("user", "Alt session message", 4),
      makeSessionEntry("assistant", "Alt session reply", 4),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), mainLines, "utf8");
    await writeFile(join(sessionsDir, "alt.jsonl"), altLines, "utf8");
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({ "user:chat:main": { sessionId: "main" }, "user:chat:alt": { sessionId: "alt" } }),
      "utf8"
    );

    const response = [
      "Date: 2026-04-01",
      "- 🟡 Alt session observation <!-- dc:type=context dc:importance=3.0 dc:date=2026-04-01 dc:session=user:chat:alt -->",
    ].join("\n");
    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: response });

    const result = await runObserver(api, DEFAULTS);

    expect(result.status).toBe("added");
    await expect(
      readFile(join(workspaceDir, "memento", "sessions", "user-chat-alt", "observations.md"), "utf8")
    ).resolves.toContain("Alt session observation");
    await expect(
      readFile(join(workspaceDir, "memento", "sessions", "user-chat-main", "observations.md"), "utf8")
    ).rejects.toThrow();
  });

  it("routes session observations with dc:session into session memory", async () => {
    const lines = [
      makeSessionEntry("user", "Keep this in the current chat only", 5),
      makeSessionEntry("assistant", "Understood", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const response = [
      "Date: 2026-04-01",
      "- 🟡 Session observation <!-- dc:type=context dc:importance=3.0 dc:date=2026-04-01 dc:session=user:chat:main -->",
    ].join("\n");
    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: response });

    const result = await runObserver(api, DEFAULTS);

    expect(result.status).toBe("added");
    await expect(
      readFile(join(workspaceDir, "memento", "sessions", "user-chat-main", "observations.md"), "utf8")
    ).resolves.toContain("Session observation");
    await expect(
      readFile(join(workspaceDir, "memento", "shared", "observations.md"), "utf8")
    ).rejects.toThrow();
  });

  it("keeps source session metadata on shared observations", async () => {
    const lines = [
      makeSessionEntry("user", "Remember my preference globally", 5),
      makeSessionEntry("assistant", "Understood", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const response = [
      "Date: 2026-04-01",
      "- 🔴 Shared preference <!-- dc:type=preference dc:importance=7.0 dc:date=2026-04-01 dc:session=user:chat:main -->",
    ].join("\n");
    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: response });

    const result = await runObserver(api, DEFAULTS);

    expect(result.status).toBe("added");
    await expect(
      readFile(join(workspaceDir, "memento", "shared", "observations.md"), "utf8")
    ).resolves.toContain("dc:session=user:chat:main");
  });

  it("routes unresolved recovery session observations into shared memory", async () => {
    const lines = [
      makeSessionEntry("user", "Recover this without a stable key", 5),
      makeSessionEntry("assistant", "Understood", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "recover.jsonl"), lines, "utf8");

    const response = [
      "Date: 2026-04-01",
      `- 🟡 Recovery note <!-- dc:type=rule dc:importance=7.0 dc:date=2026-04-01 dc:session=${UNRESOLVED_RECOVERY_SESSION_KEY} -->`,
    ].join("\n");
    const api = makeMockApi({ workspaceDir, sessionsDir, assistantResponse: response });

    const result = await runObserver(api, DEFAULTS, {
      recoverMode: true,
      recoverSessionPath: join(sessionsDir, "recover.jsonl"),
    });

    expect(result.status).toBe("added");
    await expect(
      readFile(join(workspaceDir, "memento", "shared", "observations.md"), "utf8")
    ).resolves.toContain("Recovery note");
    await expect(
      readFile(join(workspaceDir, "memento", "sessions", "unknown", "observations.md"), "utf8")
    ).rejects.toThrow();
  });

  it("returns skipped_dedup on second run with same content", async () => {
    const lines = [
      makeSessionEntry("user", "Same content twice", 5),
      makeSessionEntry("assistant", "Indeed the same content", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });

    // First run — should add observations
    const first = await runObserver(api, DEFAULTS);
    expect(first.status).toBe("added");

    // Rewind cursor so the second run's lookback window covers the session entries
    await writeFile(
      join(workspaceDir, "memento", "shared", "last-observed-at"),
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      "utf8"
    );

    // Second run — same content, should be deduped
    const second = await runObserver(api, DEFAULTS);
    expect(second.status).toBe("skipped_dedup");
  });

  it("skips dedup in flushMode", async () => {
    const lines = [
      makeSessionEntry("user", "Flush mode message", 5),
      makeSessionEntry("assistant", "Flush mode response", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });

    // First run
    await runObserver(api, DEFAULTS);

    // Second run in flush mode — should NOT be skipped by dedup
    const flush = await runObserver(api, DEFAULTS, { flushMode: true });
    expect(flush.status).not.toBe("skipped_dedup");
  });

  it("returns error when model call fails after all retries", async () => {
    const lines = [
      makeSessionEntry("user", "Test error path", 5),
      makeSessionEntry("assistant", "Test response", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({
      workspaceDir,
      sessionsDir,
      subagentError: new Error("API timeout"),
    });
    const result = await runObserver(api, {
      ...DEFAULTS,
      logging: true,
    });
    expect(result.status).toBe("error");

    const logFile = join(workspaceDir, "memento", "memento.log");
    const logContent = await readFile(logFile, "utf8");
    expect(logContent).toContain("OBSERVER_TRIGGERED");
    expect(logContent).toContain("OBSERVER_FAILED: model call failed (Error: API timeout)");
  });

  it("writes observer trigger and success summary to memento.log when file logging is enabled", async () => {
    const lines = [
      makeSessionEntry("user", "Log test message", 5),
      makeSessionEntry("assistant", "Log response", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });
    await runObserver(api, {
      ...DEFAULTS,
      logging: true,
    });

    const logFile = join(workspaceDir, "memento", "memento.log");
    const logContent = await readFile(logFile, "utf8");
    expect(logContent).toContain("[cron] OBSERVER_TRIGGERED");
    expect(logContent).toContain("[cron] OBSERVER_ADDED: 1 bullets, 1 sessions scanned");
  });

  it("does not write memento.log when file logging is disabled", async () => {
    const lines = [
      makeSessionEntry("user", "Disabled logging test", 5),
      makeSessionEntry("assistant", "Still add observations", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");

    const api = makeMockApi({ workspaceDir, sessionsDir });
    const result = await runObserver(api, DEFAULTS);

    expect(result.status).toBe("added");
    const obsFile = join(workspaceDir, "memento", "shared", "observations.md");
    await expect(readFile(obsFile, "utf8")).resolves.toContain("🔴");
    await expect(readFile(join(workspaceDir, "memento", "memento.log"), "utf8")).rejects.toThrow();
  });
});
