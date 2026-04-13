import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerHooks } from "../src/hooks.js";
import { DEFAULTS } from "../src/config.js";

const {
  runObserverMock,
  invalidateObservationPromptCacheMock,
  appendLogMock,
  registerSessionRecoveryMock,
} = vi.hoisted(() => ({
  runObserverMock: vi.fn(),
  invalidateObservationPromptCacheMock: vi.fn(),
  appendLogMock: vi.fn(),
  registerSessionRecoveryMock: vi.fn(),
}));

vi.mock("../src/observer/observer.js", () => ({
  runObserver: runObserverMock,
}));

vi.mock("../src/context-engine.js", () => ({
  invalidateObservationPromptCache: invalidateObservationPromptCacheMock,
}));

vi.mock("../src/utils/log.js", () => ({
  appendLog: appendLogMock,
}));

vi.mock("../src/session-recovery.js", () => ({
  registerSessionRecovery: registerSessionRecoveryMock,
}));

type HandlerMap = Partial<Record<"session_start" | "before_compaction" | "after_compaction", () => unknown>>;
type TranscriptUpdate = {
  sessionKey?: string;
  messageId?: string;
  message?: { role?: string; content?: Array<{ text?: string }> | string };
};

function makeMockApi(): OpenClawPluginApi & { handlers: HandlerMap } {
  const handlers: HandlerMap = {};

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
          resolveStorePath: () => "/tmp/sessions.json",
        },
        resolveAgentWorkspaceDir: () => "/tmp/workspace",
        resolveAgentDir: () => "/tmp/workspace",
        runEmbeddedPiAgent: vi.fn().mockResolvedValue({ payloads: [], meta: {} }),
      },
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn(),
        deleteSession: vi.fn(),
      },
      system: {
        runCommandWithTimeout: vi.fn(),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn(),
      },
    },
    on: vi.fn((event: keyof HandlerMap, handler: () => unknown) => {
      handlers[event] = handler;
    }),
    registerHook: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerTool: vi.fn(),
    handlers,
  } as unknown as OpenClawPluginApi & { handlers: HandlerMap };
}

describe("registerHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runObserverMock.mockResolvedValue({ status: "added", observationsAdded: 1, sessionsScanned: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function getTranscriptListener(api: ReturnType<typeof makeMockApi>): (update: TranscriptUpdate) => void {
    const call = vi.mocked(api.runtime.events.onSessionTranscriptUpdate).mock.calls.at(0);
    if (!call) throw new Error("transcript listener was not registered");
    return call[0] as (update: TranscriptUpdate) => void;
  }

  it("preserves the watcher turn counter across session_start events for the same agent", async () => {
    const api = makeMockApi();
    registerHooks(api, { ...DEFAULTS, watcher: { turnThreshold: 2 }, logging: true });
    const onTranscript = getTranscriptListener(api);

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "preserve-a", message: { role: "assistant", content: [{ text: "First" }] } });
    expect(runObserverMock).not.toHaveBeenCalled();

    api.handlers.session_start?.();
    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "preserve-b", message: { role: "assistant", content: [{ text: "Second" }] } });
    await Promise.resolve();

    expect(runObserverMock).toHaveBeenCalledTimes(1);
  });

  it("runs the embedded observer path when the transcript watcher threshold is reached", async () => {
    const api = makeMockApi();
    registerHooks(api, { ...DEFAULTS, watcher: { turnThreshold: 2 }, logging: true });
    const onTranscript = getTranscriptListener(api);

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "threshold-a", message: { role: "assistant", content: [{ text: "First" }] } });
    expect(runObserverMock).not.toHaveBeenCalled();

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "threshold-b", message: { role: "assistant", content: [{ text: "Second" }] } });
    await Promise.resolve();

    expect(runObserverMock).toHaveBeenCalledTimes(1);
    expect(runObserverMock).toHaveBeenCalledWith(
      api,
      { ...DEFAULTS, watcher: { turnThreshold: 2 }, logging: true },
      { agentId: "main", triggerTag: "[watcher]" }
    );
    expect(appendLogMock).toHaveBeenNthCalledWith(
      1,
      "/tmp/workspace/memento/memento.log",
      "[watcher] transcript watcher triggered observer (2 replies)",
      true
    );
    expect(appendLogMock).toHaveBeenNthCalledWith(
      2,
      "/tmp/workspace/memento/memento.log",
      "[watcher] complete — status=added, added=1",
      true
    );
  });

  it("ignores non-meaningful assistant transcript updates and duplicate message ids", () => {
    const api = makeMockApi();
    registerHooks(api, { ...DEFAULTS, watcher: { turnThreshold: 1 }, logging: true });
    const onTranscript = getTranscriptListener(api);

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "dup", message: { role: "assistant", content: [{ text: "NO_REPLY" }] } });
    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "dup", message: { role: "assistant", content: [{ text: "Real reply" }] } });
    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "dup", message: { role: "assistant", content: [{ text: "Real reply" }] } });

    expect(runObserverMock).toHaveBeenCalledTimes(1);
  });

  it("logs watcher observer failures", async () => {
    const api = makeMockApi();
    runObserverMock.mockRejectedValueOnce(new Error("embedded runtime unavailable"));
    registerHooks(api, { ...DEFAULTS, watcher: { turnThreshold: 1 }, logging: true });
    const onTranscript = getTranscriptListener(api);

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "failure-a", message: { role: "assistant", content: [{ text: "Real reply" }] } });
    await Promise.resolve();
    await Promise.resolve();

    expect(appendLogMock).toHaveBeenNthCalledWith(
      1,
      "/tmp/workspace/memento/memento.log",
      "[watcher] transcript watcher triggered observer (1 replies)",
      true
    );
    expect(appendLogMock).toHaveBeenNthCalledWith(
      2,
      "/tmp/workspace/memento/memento.log",
      "[watcher] ERROR: observer run failed (Error: embedded runtime unavailable)",
      true
    );
  });

  it("tracks watcher counters independently by agent derived from session key", async () => {
    const api = makeMockApi();
    const resolveAgentWorkspaceDir = vi.fn((_config, agentId: string) => `/tmp/workspace/${agentId}`);
    api.runtime.agent.resolveAgentWorkspaceDir = resolveAgentWorkspaceDir;

    registerHooks(api, { ...DEFAULTS, watcher: { turnThreshold: 2 }, logging: true });
    const onTranscript = getTranscriptListener(api);

    onTranscript({ sessionKey: "agent:main:discord:channel:1", messageId: "agent-main-a", message: { role: "assistant", content: [{ text: "Main one" }] } });
    expect(runObserverMock).not.toHaveBeenCalled();

    onTranscript({ sessionKey: "agent:other:discord:channel:2", messageId: "agent-other-a", message: { role: "assistant", content: [{ text: "Other one" }] } });
    expect(runObserverMock).not.toHaveBeenCalled();

    onTranscript({ sessionKey: "agent:other:discord:channel:2", messageId: "agent-other-b", message: { role: "assistant", content: [{ text: "Other two" }] } });
    await Promise.resolve();

    expect(runObserverMock).toHaveBeenCalledTimes(1);
    expect(runObserverMock).toHaveBeenCalledWith(
      api,
      { ...DEFAULTS, watcher: { turnThreshold: 2 }, logging: true },
      { agentId: "other", triggerTag: "[watcher]" }
    );
  });

  it("invalidates prompt cache on session_start and after_compaction", () => {
    const api = makeMockApi();
    registerHooks(api, DEFAULTS);

    api.handlers.session_start?.();
    api.handlers.after_compaction?.();

    expect(invalidateObservationPromptCacheMock).toHaveBeenCalledTimes(2);
  });
});
