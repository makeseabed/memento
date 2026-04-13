import { describe, expect, it } from "vitest";
import { encodeSessionStoreKey, resolveMementoPaths } from "../src/paths.js";

describe("resolveMementoPaths", () => {
  it("stores shared memory directly under memento", () => {
    expect(resolveMementoPaths("/tmp/workspace")).toEqual({
      agentMementoDir: "/tmp/workspace/memento",
      storeDir: "/tmp/workspace/memento/shared",
      observationsPath: "/tmp/workspace/memento/shared/observations.md",
      backupDir: "/tmp/workspace/memento/shared/backups",
      logPath: "/tmp/workspace/memento/memento.log",
      observerStatePath: "/tmp/workspace/memento/.observer-state.json",
      lastObservedAtPath: "/tmp/workspace/memento/shared/last-observed-at",
    });
  });

  it("ignores agentId for workspace-local storage", () => {
    expect(resolveMementoPaths("/tmp/workspace", "research")).toEqual({
      agentMementoDir: "/tmp/workspace/memento",
      storeDir: "/tmp/workspace/memento/shared",
      observationsPath: "/tmp/workspace/memento/shared/observations.md",
      backupDir: "/tmp/workspace/memento/shared/backups",
      logPath: "/tmp/workspace/memento/memento.log",
      observerStatePath: "/tmp/workspace/memento/.observer-state.json",
      lastObservedAtPath: "/tmp/workspace/memento/shared/last-observed-at",
    });
  });

  it("places session-scoped storage under a stable dashed session folder", () => {
    expect(
      resolveMementoPaths("/tmp/workspace", "main", {
        scope: "session",
        sessionKey: "agent:main:discord:channel:123",
      })
    ).toEqual({
      agentMementoDir: "/tmp/workspace/memento",
      storeDir: "/tmp/workspace/memento/sessions/agent-main-discord-channel-123",
      observationsPath: "/tmp/workspace/memento/sessions/agent-main-discord-channel-123/observations.md",
      backupDir: "/tmp/workspace/memento/sessions/agent-main-discord-channel-123/backups",
      logPath: "/tmp/workspace/memento/memento.log",
      observerStatePath: "/tmp/workspace/memento/.observer-state.json",
      lastObservedAtPath: "/tmp/workspace/memento/sessions/agent-main-discord-channel-123/last-observed-at",
    });
  });

  it("formats colon-delimited session keys into stable dashed folder names", () => {
    expect(encodeSessionStoreKey("agent:main:discord:channel:1480872431068516454")).toBe(
      "agent-main-discord-channel-1480872431068516454"
    );
    expect(encodeSessionStoreKey("user:chat:main")).toBe("user-chat-main");
  });
});
