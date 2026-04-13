import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerObserverTool } from "../src/observer/tools.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULTS } from "../src/config.js";

function makeMockApi(opts: { workspaceDir: string; sessionsDir: string }): OpenClawPluginApi & {
  registeredTools: Map<string, { execute: (p: Record<string, unknown>) => Promise<unknown> }>;
} {
  const registeredTools = new Map<
    string,
    { execute: (p: Record<string, unknown>) => Promise<unknown> }
  >();

  const api = {
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      agent: {
        session: { resolveStorePath: () => join(opts.sessionsDir, "sessions.json") },
        resolveAgentWorkspaceDir: () => opts.workspaceDir,
        resolveAgentDir: () => opts.workspaceDir,
        runEmbeddedPiAgent: () => Promise.resolve({ payloads: [{ text: "NO_OBSERVATIONS" }], meta: {} }),
      },
      subagent: {
        run: () => Promise.resolve({ runId: "test-run-id" }),
        waitForRun: () => Promise.resolve({}),
        getSessionMessages: () =>
          Promise.resolve({
            messages: [{ role: "assistant", content: "NO_OBSERVATIONS" }],
          }),
        deleteSession: () => Promise.resolve(),
      },
      system: {
        runCommandWithTimeout: () =>
          Promise.resolve({ stdout: "[]", stderr: "", exitCode: 0 }),
      },
      events: { onSessionTranscriptUpdate: () => undefined },
    },
    registerHook: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerTool(toolOrFactory: unknown) {
      // Support both direct tool objects and factory functions ((_ctx) => tool)
      const tool = typeof toolOrFactory === "function"
        ? (toolOrFactory as (_ctx: unknown) => { name: string; execute: (p: Record<string, unknown>) => Promise<unknown> })(undefined)
        : (toolOrFactory as { name: string; execute: (p: Record<string, unknown>) => Promise<unknown> });
      registeredTools.set(tool.name, tool);
    },
    registeredTools,
  };

  return api as unknown as ReturnType<typeof makeMockApi>;
}

describe("registerObserverTool", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-tools-test-${Date.now()}`);
    workspaceDir = join(tmpDir, "workspace");
    sessionsDir = join(tmpDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(join(workspaceDir, "memento", "logs"), { recursive: true });
    await mkdir(join(workspaceDir, "memento", "shared"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers a tool named memento_observe", () => {
    const api = makeMockApi({ workspaceDir, sessionsDir });
    registerObserverTool(api, DEFAULTS);
    expect(api.registeredTools.has("memento_observe")).toBe(true);
  });

  it("returns observer run complete text on success", async () => {
    const api = makeMockApi({ workspaceDir, sessionsDir });
    registerObserverTool(api, DEFAULTS);

    const tool = api.registeredTools.get("memento_observe")!;
    const result = await tool.execute({}) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toBe("Observer run complete");
  });

  it("passes flushMode=true when mode is flush", async () => {
    const api = makeMockApi({ workspaceDir, sessionsDir });
    registerObserverTool(api, DEFAULTS);

    const tool = api.registeredTools.get("memento_observe")!;
    // Should not throw — flush mode uses longer lookback
    const result = await tool.execute({ mode: "flush" }) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text).toBe("Observer run complete");
  });
});
