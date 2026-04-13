import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateObservationPromptCache, registerContextEngine } from "../src/context-engine.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULTS } from "../src/config.js";

type MemoryPromptBuilder = (params: { availableTools: Set<string>; agentId?: string; sessionKey?: string }) => string[];

function makeMockApi(workspaceDir: string): OpenClawPluginApi & { getBuilder(): MemoryPromptBuilder | undefined } {
  let capturedBuilder: MemoryPromptBuilder | undefined;

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
        session: {
          resolveStorePath: () => workspaceDir,
        },
        resolveAgentWorkspaceDir: () => workspaceDir,
        resolveAgentDir: () => workspaceDir,
        runEmbeddedPiAgent: () => Promise.resolve({ payloads: [], meta: {} }),
      },
      subagent: {
        run: () => Promise.resolve({ runId: "test" }),
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
    registerMemoryPromptSection: vi.fn((builder: MemoryPromptBuilder) => {
      capturedBuilder = builder;
    }),
    registerTool: vi.fn(),
    getBuilder() {
      return capturedBuilder;
    },
  };

  return api as unknown as OpenClawPluginApi & { getBuilder(): MemoryPromptBuilder | undefined };
}

const BASE_PARAMS = { availableTools: new Set<string>() };

describe("registerContextEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    invalidateObservationPromptCache();
    tmpDir = join(tmpdir(), `memento-ctx-test-${Date.now()}`);
    await mkdir(join(tmpDir, "memento", "shared"), { recursive: true });
    await mkdir(join(tmpDir, "memento", "logs"), { recursive: true });
  });

  afterEach(async () => {
    invalidateObservationPromptCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers a builder by default", () => {
    const api = makeMockApi(tmpDir);

    registerContextEngine(api, DEFAULTS);

    expect(api.registerMemoryPromptSection).toHaveBeenCalledOnce();
  });

  it("injects placeholder when observations.md does not exist", () => {
    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;
    const result = builder(BASE_PARAMS);

    expect(result).toEqual(["<!-- Memento: no observations yet -->"]);
  });

  it("injects placeholder when observations.md is empty", async () => {
    await writeFile(join(tmpDir, "memento/shared/observations.md"), "   \n  ", "utf8");

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;
    const result = builder(BASE_PARAMS);

    expect(result).toEqual(["<!-- Memento: no observations yet -->"]);
  });

  it("wraps content in memento-observations tags when file exists", async () => {
    const content = "- 🔴 Something important happened\n- 🟡 Some context\n";
    await writeFile(join(tmpDir, "memento/shared/observations.md"), content, "utf8");

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;
    const result = builder(BASE_PARAMS);

    expect(result).toEqual([
      "<memento-observations>",
      `<shared-observations>\n${content}\n</shared-observations>`,
      "</memento-observations>",
    ]);
  });

  it("truncates content cleanly when file exceeds 50k token limit", async () => {
    // 50,000 tokens * 4 chars/token = 200,000 chars; write 201,000 to exceed limit
    const bigContent = "x".repeat(201_000);
    await writeFile(join(tmpDir, "memento/shared/observations.md"), bigContent, "utf8");

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;
    const result = builder(BASE_PARAMS);

    // Should be wrapped in tags
    expect(result[0]).toBe("<memento-observations>");
    expect(result[2]).toBe("</memento-observations>");

    // Middle section is truncated at the combined payload boundary, so wrapper text may be cut.
    const injected = result[1]!;
    expect(injected.startsWith("<shared-observations>\n")).toBe(true);
    expect(injected).toContain(bigContent.slice(0, 1024));
    // Should not include the full file
    expect(injected.length).toBe(200_000);

    // Should have logged a warning
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("50,000-token soft limit")
    );
  });

  it("caches the file read across multiple builder calls", async () => {
    const content = "- 🔴 Important observation\n";
    await writeFile(join(tmpDir, "memento/shared/observations.md"), content, "utf8");

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;

    const result1 = builder(BASE_PARAMS);
    expect(result1[1]).toContain(content);

    await rm(join(tmpDir, "memento/shared/observations.md"));

    const result2 = builder(BASE_PARAMS);
    expect(result2).toEqual(result1);
  });

  it("refreshes after explicit cache invalidation", async () => {
    await writeFile(join(tmpDir, "memento/shared/observations.md"), "- 🔴 First\n", "utf8");

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);

    const builder = api.getBuilder()!;
    expect(builder(BASE_PARAMS)).toEqual([
      "<memento-observations>",
      "<shared-observations>\n- 🔴 First\n\n</shared-observations>",
      "</memento-observations>",
    ]);

    await writeFile(join(tmpDir, "memento/shared/observations.md"), "- 🔴 Second\n", "utf8");
    expect(builder(BASE_PARAMS)).toEqual([
      "<memento-observations>",
      "<shared-observations>\n- 🔴 First\n\n</shared-observations>",
      "</memento-observations>",
    ]);

    invalidateObservationPromptCache();

    expect(builder(BASE_PARAMS)).toEqual([
      "<memento-observations>",
      "<shared-observations>\n- 🔴 Second\n\n</shared-observations>",
      "</memento-observations>",
    ]);
  });

  it("injects shared observations for every session and session observations only for the current session key", async () => {
    await writeFile(join(tmpDir, "memento/shared/observations.md"), "- 🔴 Shared fact\n", "utf8");
    await mkdir(join(tmpDir, "memento/sessions/agent-main-discord-channel-123"), { recursive: true });
    await writeFile(
      join(tmpDir, "memento/sessions/agent-main-discord-channel-123/observations.md"),
      "- 🟡 Session detail\n",
      "utf8"
    );

    const api = makeMockApi(tmpDir);
    registerContextEngine(api, DEFAULTS);
    const builder = api.getBuilder()!;

    expect(
      builder({ ...BASE_PARAMS, sessionKey: "agent:main:discord:channel:123" })
    ).toEqual([
      "<memento-observations>",
      "<shared-observations>\n- 🔴 Shared fact\n\n</shared-observations>\n\n<session-observations>\n- 🟡 Session detail\n\n</session-observations>",
      "</memento-observations>",
    ]);

    expect(builder({ ...BASE_PARAMS, sessionKey: "agent:main:discord:channel:999" })).toEqual([
      "<memento-observations>",
      "<shared-observations>\n- 🔴 Shared fact\n\n</shared-observations>",
      "</memento-observations>",
    ]);
  });
});
