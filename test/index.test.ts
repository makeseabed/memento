import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";

const { mkdirMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
}));

import manifest from "../openclaw.plugin.json";
import mementoPlugin from "../src/index.js";

// Reset startup banner state between tests so logStartupBannerOnce fires each time
beforeEach(() => {
  const sym = Symbol.for("@memento/startup-banner-state");
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[sym];
  mkdirMock.mockClear();
});

function buildMockApi(pluginConfig?: Record<string, unknown>) {
  const infoLog = vi.fn();
  const warnLog = vi.fn();
  const registeredTools: Array<{ factory: AnyAgentTool | OpenClawPluginToolFactory; opts?: unknown }> = [];
  const registeredServices: Array<{ id: string }> = [];
  const memorySectionBuilders: Array<CallableFunction> = [];
  const onCalls: Array<string> = [];

  const api = {
    id: "memento",
    name: "Memento",
    version: "0.1.0",
    source: "test",
    registrationMode: "eager",
    config: {} as unknown as OpenClawPluginApi["config"],
    pluginConfig: pluginConfig ?? {},
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: () => "/tmp/test-workspace",
        resolveAgentDir: () => "/tmp/test-workspace",
        runEmbeddedPiAgent: vi.fn().mockResolvedValue({ payloads: [], meta: {} }),
        session: { resolveStorePath: () => "/tmp/test-workspace/sessions/s.jsonl" },
      },
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
        deleteSession: vi.fn(),
        getSession: vi.fn(),
      },
      system: { runCommandWithTimeout: vi.fn() },
      events: { onSessionTranscriptUpdate: vi.fn(), onAgentEvent: vi.fn() },
    },
    logger: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
    registerTool: vi.fn((factory: AnyAgentTool | OpenClawPluginToolFactory, opts?: unknown) => {
      registeredTools.push({ factory, opts });
    }),
    registerService: vi.fn((service: { id: string }) => {
      registeredServices.push({ id: service.id });
    }),
    registerMemoryPromptSection: vi.fn((builder: CallableFunction) => {
      memorySectionBuilders.push(builder);
    }),
    on: vi.fn((_event: string) => {
      onCalls.push(_event);
    }),
    registerHook: vi.fn(),
    registerContextEngine: vi.fn(),
    registerChannel: vi.fn(),
    registerCli: vi.fn(),
    registerCliBackend: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebFetchProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerCommand: vi.fn(),
    registerMemoryFlushPlan: vi.fn(),
    registerMemoryRuntime: vi.fn(),
    registerMemoryEmbeddingProvider: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    resolvePath: (p: string) => p,
  } as unknown as OpenClawPluginApi;

  return { api, registeredTools, registeredServices, memorySectionBuilders, onCalls, infoLog, warnLog };
}

describe("mementoPlugin.register()", () => {
  it("registers the observer tool as a factory function", () => {
    const { api, registeredTools } = buildMockApi();
    mementoPlugin.register(api);
    expect(registeredTools.length).toBeGreaterThanOrEqual(1);
    expect(typeof registeredTools[0]!.factory).toBe("function");
  });

  it("registers a before_prompt_build hook for memory injection", () => {
    const { api, memorySectionBuilders, onCalls } = buildMockApi();
    mementoPlugin.register(api);
    expect(memorySectionBuilders.length).toBe(0);
    expect(onCalls).toContain("before_prompt_build");
  });

  it("registers session and compaction hooks and transcript watcher subscriptions", () => {
    const { api, onCalls } = buildMockApi();
    mementoPlugin.register(api);
    expect(onCalls).toContain("session_start");
    expect(onCalls).toContain("before_compaction");
    expect(onCalls).toContain("after_compaction");
    expect(api.runtime.events.onSessionTranscriptUpdate).toHaveBeenCalledTimes(1);
  });

  it("registers before_reset hook for session recovery via api.on", () => {
    const { api, onCalls } = buildMockApi();
    mementoPlugin.register(api);
    expect(onCalls).toContain("before_reset");
  });

  it("logs the startup banner on first register()", () => {
    const { api, infoLog } = buildMockApi();
    mementoPlugin.register(api);
    const bannerCalls = infoLog.mock.calls.filter((c) => String(c[0]).includes("Memento v"));
    expect(bannerCalls.length).toBe(1);
  });

  it("does not eagerly create a log directory on register()", () => {
    const { api } = buildMockApi({ logging: true });
    mementoPlugin.register(api);
    expect(mkdirMock).toHaveBeenCalledTimes(1);
    expect(mkdirMock).toHaveBeenCalledWith("/tmp/test-workspace/memento/shared/backups", { recursive: true });
  });

  it("does not log startup banner twice when register() is called twice", () => {
    const { api, infoLog } = buildMockApi();
    mementoPlugin.register(api);
    mementoPlugin.register(api);
    const bannerCalls = infoLog.mock.calls.filter((c) => String(c[0]).includes("Memento v"));
    expect(bannerCalls.length).toBe(1);
  });
});

describe("mementoPlugin.configSchema", () => {
  it("exposes configSchema with a parse() method", () => {
    expect(mementoPlugin.configSchema).toBeDefined();
    expect(typeof (mementoPlugin.configSchema as { parse?: unknown }).parse).toBe("function");
  });

  it("parse() returns a resolved config with given overrides", () => {
    const schema = mementoPlugin.configSchema as { parse: (v: unknown) => { observer: { maxSessions: number } } };
    const result = schema.parse({ observer: { maxSessions: 5 } });
    expect(result.observer.maxSessions).toBe(5);
  });

  it("parse() fills defaults when called with empty object", () => {
    const schema = mementoPlugin.configSchema as { parse: (v: unknown) => { observer: { maxSessions: number } } };
    const result = schema.parse({});
    expect(result.observer.maxSessions).toBe(10);
  });

  it("parse() defaults file logging to off", () => {
    const schema = mementoPlugin.configSchema as { parse: (v: unknown) => { logging: boolean } };
    const result = schema.parse({});
    expect(result.logging).toBe(false);
  });
});

describe("openclaw.plugin.json", () => {
  it("declares the top-level logging config key", () => {
    const properties = (manifest.configSchema as { properties?: Record<string, unknown> }).properties;
    expect(properties).toBeDefined();
    expect(properties).toHaveProperty("logging");
  });
});
