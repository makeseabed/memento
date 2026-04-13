import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULTS } from "../src/config.js";
import { readRecentSessions } from "../src/observer/session-reader.js";
import { LOG_FILE, OBSERVATIONS_FILE } from "../src/paths.js";

// Mock runObserver before importing the module under test
vi.mock("../src/observer/observer.js", () => ({
  runObserver: vi.fn(),
}));

import { runObserver } from "../src/observer/observer.js";
import { handleSessionRecovery, registerSessionRecovery } from "../src/session-recovery.js";

const mockRunObserver = vi.mocked(runObserver);

function makeMockApi(workspaceDir: string): OpenClawPluginApi {
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
        session: { resolveStorePath: () => workspaceDir },
        resolveAgentWorkspaceDir: () => workspaceDir,
        resolveAgentDir: () => workspaceDir,
        runEmbeddedPiAgent: () => Promise.resolve({ payloads: [], meta: {} }),
      },
      subagent: {
        run: () => Promise.resolve({ runId: "test-run" }),
        waitForRun: () => Promise.resolve({}),
        getSessionMessages: () => Promise.resolve({ messages: [] }),
        deleteSession: () => Promise.resolve(),
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

function makeSessionLine(role: string, content: string, minutesAgo = 5): string {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return JSON.stringify({ timestamp: ts, message: { role, content } });
}

describe("handleSessionRecovery", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-recovery-test-${Date.now()}`);
    sessionsDir = join(tmpDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(join(tmpDir, "memento", "shared"), { recursive: true });
    await mkdir(join(tmpDir, "memento", "logs"), { recursive: true });
    mockRunObserver.mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips when no session path in event context", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };

    await handleSessionRecovery(api, config, {});

    expect(mockRunObserver).not.toHaveBeenCalled();
    const log = await readFile(join(tmpDir, LOG_FILE), "utf8").catch(() => "");
    expect(log).toContain("[session-recovery] no previous session path");
  });

  it("skips when session hash matches stored hash", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };

    const sessionFile = join(sessionsDir, "session-abc.jsonl");
    const lines = [
      makeSessionLine("user", "hello"),
      makeSessionLine("assistant", "hi there"),
    ];
    await writeFile(sessionFile, lines.join("\n") + "\n", "utf8");

    // Pre-compute hash using the same formatted-message extraction as session-recovery.ts
    const { computeHash } = await import("../src/observer/dedup.js");
    const { messages } = await readRecentSessions("", config, {
      lookbackMinutes: config.memoryFlush.recoverLookbackHours * 60,
      recoverSessionPath: sessionFile,
    });
    const hash = computeHash(messages.join("\n"));
    await writeFile(
      join(tmpDir, "memento", ".observer-state.json"),
      JSON.stringify({ hashes: { [sessionFile]: hash } }),
      "utf8"
    );

    await handleSessionRecovery(api, config, { previousSessionPath: sessionFile });

    expect(mockRunObserver).not.toHaveBeenCalled();
    const log = await readFile(join(tmpDir, LOG_FILE), "utf8").catch(() => "");
    expect(log).toContain("already observed");
  });

  it("calls runObserver in recoverMode when hash mismatches", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };

    const sessionFile = join(sessionsDir, "session-xyz.jsonl");
    const lines = [
      makeSessionLine("user", "important decision made"),
      makeSessionLine("assistant", "understood"),
    ];
    await writeFile(sessionFile, lines.join("\n") + "\n", "utf8");

    // No stored hash → hash mismatch
    mockRunObserver.mockResolvedValue({
      status: "added",
      observationsAdded: 2,
      sessionsScanned: 1,
    });

    await handleSessionRecovery(api, config, { previousSessionPath: sessionFile });

    expect(mockRunObserver).toHaveBeenCalledOnce();
    expect(mockRunObserver).toHaveBeenCalledWith(
      api,
      config,
      expect.objectContaining({
        agentId: "main",
        recoverMode: true,
        recoverSessionPath: sessionFile,
        triggerTag: "[session-recovery]",
      })
    );

    const log = await readFile(join(tmpDir, LOG_FILE), "utf8").catch(() => "");
    expect(log).toContain("unobserved session detected");
    expect(log).toContain("recover-mode observer completed successfully");
  });

  it("prefers the runtime session key from the reset event when available", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };
    const sessionFile = join(sessionsDir, "session-runtime-key.jsonl");
    await writeFile(sessionFile, [makeSessionLine("user", "keep this"), makeSessionLine("assistant", "ok")].join("\n") + "\n", "utf8");

    mockRunObserver.mockResolvedValue({
      status: "added",
      observationsAdded: 1,
      sessionsScanned: 1,
    });

    await handleSessionRecovery(api, config, {
      previousSessionPath: sessionFile,
      sessionKey: "agent:main:discord:channel:runtime",
    });

    expect(mockRunObserver).toHaveBeenCalledWith(
      api,
      config,
      expect.objectContaining({
        recoverSessionKey: "agent:main:discord:channel:runtime",
      })
    );
  });

  it("falls back to raw-text capture when runObserver throws", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };

    const sessionFile = join(sessionsDir, "session-fail.jsonl");
    const lines = [
      makeSessionLine("user", "something important happened"),
      makeSessionLine("assistant", "I will remember that"),
    ];
    await writeFile(sessionFile, lines.join("\n") + "\n", "utf8");

    mockRunObserver.mockRejectedValue(new Error("subagent unavailable"));

    await handleSessionRecovery(api, config, { previousSessionPath: sessionFile });

    expect(mockRunObserver).toHaveBeenCalledOnce();

    const observationsPath = join(tmpDir, OBSERVATIONS_FILE);
    const observations = await readFile(observationsPath, "utf8");
    expect(observations).toContain("<!-- Session Recovery Capture:");
    expect(observations).toContain("USER: something important happened");
    expect(observations).toContain("ASSISTANT: I will remember that");

    const log = await readFile(join(tmpDir, LOG_FILE), "utf8").catch(() => "");
    expect(log).toContain("raw-text fallback");
    expect(log).toContain("captured 2 messages");
  });

  it("prefers ctx.sessionKey over the reset event payload", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };
    const sessionFile = join(sessionsDir, "session-context-key.jsonl");
    await writeFile(sessionFile, [makeSessionLine("user", "keep this"), makeSessionLine("assistant", "ok")].join("\n") + "\n", "utf8");

    mockRunObserver.mockResolvedValue({
      status: "added",
      observationsAdded: 1,
      sessionsScanned: 1,
    });

    await handleSessionRecovery(
      api,
      config,
      { previousSessionPath: sessionFile, sessionKey: "agent:main:discord:channel:event" },
      { sessionKey: "agent:main:discord:channel:ctx" }
    );

    expect(mockRunObserver).toHaveBeenCalledWith(
      api,
      config,
      expect.objectContaining({
        recoverSessionKey: "agent:main:discord:channel:ctx",
      })
    );
  });

  it("routes raw recovery fallback to shared memory when session key cannot be resolved", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };
    const sessionFile = join(sessionsDir, "session-unresolved.jsonl");
    await writeFile(sessionFile, [makeSessionLine("user", "keep this shared"), makeSessionLine("assistant", "got it")].join("\n") + "\n", "utf8");

    mockRunObserver.mockRejectedValue(new Error("subagent unavailable"));

    await handleSessionRecovery(api, config, { previousSessionPath: sessionFile });

    await expect(readFile(join(tmpDir, OBSERVATIONS_FILE), "utf8")).resolves.toContain("keep this shared");
    await expect(readFile(join(tmpDir, "memento", "sessions", "unknown", "observations.md"), "utf8")).rejects.toThrow();
  });

  it("reads previousSession.path from nested event context", async () => {
    const api = makeMockApi(tmpDir);
    const config = { ...DEFAULTS, logging: true };

    const sessionFile = join(sessionsDir, "session-nested.jsonl");
    await writeFile(sessionFile, makeSessionLine("user", "hello from nested context") + "\n", "utf8");

    mockRunObserver.mockResolvedValue({
      status: "added",
      observationsAdded: 1,
      sessionsScanned: 1,
    });

    await handleSessionRecovery(api, config, {
      previousSession: { path: sessionFile },
    });

    expect(mockRunObserver).toHaveBeenCalledWith(
      api,
      config,
      expect.objectContaining({ recoverMode: true, recoverSessionPath: sessionFile })
    );
  });

  it("registers before_reset hook that routes through handleSessionRecovery", async () => {
    const api = makeMockApi(tmpDir) as OpenClawPluginApi & { on: ReturnType<typeof vi.fn> };
    const config = { ...DEFAULTS, logging: true };

    const handlers = new Map<string, (event: unknown, ctx?: { sessionKey?: string }) => Promise<void>>();
    vi.mocked(api.on).mockImplementation((event: string, handler: (event: unknown, ctx?: { sessionKey?: string }) => Promise<void>) => {
      handlers.set(event, handler);
      return api;
    });

    const sessionFile = join(sessionsDir, "session-before-reset.jsonl");
    await writeFile(sessionFile, makeSessionLine("user", "recover this") + "\n", "utf8");
    mockRunObserver.mockResolvedValue({ status: "added", observationsAdded: 1, sessionsScanned: 1 });

    registerSessionRecovery(api, config);
    await handlers.get("before_reset")?.({ sessionFile }, { sessionKey: "agent:main:discord:channel:ctx-reset" });

    expect(handlers.has("before_reset")).toBe(true);
    expect(mockRunObserver).toHaveBeenCalledWith(
      api,
      config,
      expect.objectContaining({
        recoverMode: true,
        recoverSessionPath: sessionFile,
        recoverSessionKey: "agent:main:discord:channel:ctx-reset",
      })
    );
  });

});
