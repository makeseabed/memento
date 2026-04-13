import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRecentSessions, resolveSessionKeyForPath, stripChannelMetadata, UNRESOLVED_RECOVERY_SESSION_KEY } from "../src/observer/session-reader.js";
import { DEFAULTS } from "../src/config.js";

function makeEntry(role: string, text: string, minutesAgo: number): string {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  return JSON.stringify({
    timestamp: ts,
    message: { role, content: text },
  });
}

// Write sessions.json mapping sessionId (filename without .jsonl) to sessionKey
async function writeSessionStore(
  sessionsDir: string,
  entries: Record<string, string> // sessionId -> sessionKey
): Promise<void> {
  const store: Record<string, { sessionId: string }> = {};
  for (const [sessionId, key] of Object.entries(entries)) {
    store[key] = { sessionId };
  }
  await writeFile(join(sessionsDir, "sessions.json"), JSON.stringify(store), "utf8");
}

describe("stripChannelMetadata", () => {
  const discordMessage = [
    "Conversation info (untrusted metadata): {\"channel\":\"discord\",\"guild\":\"test\"}",
    "Sender (untrusted metadata): {\"id\":\"123\",\"name\":\"Mike\"}",
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc123">>>',
    "Hey, what's the status on the build pipeline?",
    "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
  ].join("\n");

  it("extracts content from inside EXTERNAL_UNTRUSTED_CONTENT tags", () => {
    expect(stripChannelMetadata(discordMessage)).toBe(
      "Hey, what's the status on the build pipeline?"
    );
  });

  it("returns original text when no EXTERNAL_UNTRUSTED_CONTENT tags found", () => {
    const plain = "Plain webchat message without any wrappers";
    expect(stripChannelMetadata(plain)).toBe(plain);
  });

  it("handles multiline content inside tags", () => {
    const msg = [
      "Conversation info (untrusted metadata): {}",
      "Sender (untrusted metadata): {}",
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="def456">>>',
      "Line one",
      "Line two",
      "Line three",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    expect(stripChannelMetadata(msg)).toBe("Line one\nLine two\nLine three");
  });

  it("returns original text when only start tag present", () => {
    const msg = '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>\nsome content';
    expect(stripChannelMetadata(msg)).toBe(msg);
  });

  it("returns original text when only end tag present", () => {
    const msg = "some content\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
    expect(stripChannelMetadata(msg)).toBe(msg);
  });

  it("returns original text when end tag comes before start tag", () => {
    const msg =
      '<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>\n<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>';
    expect(stripChannelMetadata(msg)).toBe(msg);
  });

  it("returns original text when inner content is empty", () => {
    const msg =
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>';
    // inner is empty after trim, falls back to original
    expect(stripChannelMetadata(msg)).toBe(msg);
  });

  it("correctly truncates the real message content (not the metadata preamble)", () => {
    // Build a message where the preamble is 570 chars and the real content is 600 chars
    const preamble = [
      "Conversation info (untrusted metadata): {\"channel\":\"discord\"}",
      "Sender (untrusted metadata): {\"id\":\"123\",\"name\":\"Mike\"}",
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="xyz789">>>',
    ].join("\n");
    const realContent = "A".repeat(600);
    const msg = preamble + "\n" + realContent + "\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";

    const stripped = stripChannelMetadata(msg);
    const truncated = stripped.slice(0, 500);
    // Should be 500 A's — the real message content, not cut off by preamble
    expect(truncated).toBe("A".repeat(500));
    expect(truncated).not.toContain("untrusted metadata");
  });
});

describe("readRecentSessions", () => {
  let sessionsDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-test-${Date.now()}`);
    sessionsDir = join(tmpDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result when sessions directory is empty", async () => {
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.sessionFiles).toHaveLength(0);
  });

  it("returns empty result when sessions directory does not exist", async () => {
    const result = await readRecentSessions("/nonexistent/path", DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
  });

  it("skips sessions not found in store", async () => {
    await writeFile(
      join(sessionsDir, "unknown.jsonl"),
      makeEntry("user", "Some message", 5),
      "utf8"
    );
    // No sessions.json written — storeMap is empty, all files skipped
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
  });

  it("extracts user and assistant messages within lookback window", async () => {
    const lines = [
      makeEntry("user", "Hello, how are you?", 5),
      makeEntry("assistant", "I am doing well, thanks!", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatch(/\[.*\] USER: Hello/);
    expect(result.messages[1]).toMatch(/\[.*\] ASSISTANT: I am doing well/);
    expect(result.sessionFiles).toHaveLength(1);
  });

  it("filters out messages outside lookback window", async () => {
    const lines = [
      makeEntry("user", "Old message outside window", 60), // 60 min ago, outside 15-min window
      makeEntry("user", "Recent message inside window", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Recent message/);
  });

  it("skips subagent session files", async () => {
    await writeFile(
      join(sessionsDir, "subagent-session.jsonl"),
      makeEntry("user", "subagent task", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "subagent-session": "agent:main:subagent:helper",
    });
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
  });

  it("skips cron session files", async () => {
    await writeFile(
      join(sessionsDir, "cron-session.jsonl"),
      makeEntry("user", "cron triggered", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "cron-session": "agent:main:cron:daily",
    });
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
  });

  it("skips memento session files (self-observation prevention)", async () => {
    await writeFile(
      join(sessionsDir, "memento-session.jsonl"),
      makeEntry("user", "OBSERVATIONS_ADDED", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "memento-session": "agent:main:memento:observer",
    });
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(0);
  });

  it("skips main (webchat) session files", async () => {
    await writeFile(
      join(sessionsDir, "main-session.jsonl"),
      makeEntry("user", "webchat message", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "main-session": "agent:main:main:webchat",
    });
    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
      agentId: "main",
    });
    expect(result.messages).toHaveLength(0);
  });

  it("includes channel sessions for the current main agent", async () => {
    await writeFile(
      join(sessionsDir, "discord-session.jsonl"),
      makeEntry("user", "discord message", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "discord-session": "agent:main:discord:channel:123",
    });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
      agentId: "main",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/discord message/);
  });

  it("skips channel sessions that belong to a different main agent", async () => {
    await writeFile(
      join(sessionsDir, "other-agent-discord.jsonl"),
      makeEntry("user", "other agent message", 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, {
      "other-agent-discord": "agent:sales:discord:channel:123",
    });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
      agentId: "main",
    });

    expect(result.messages).toHaveLength(0);
  });

  it("filters heartbeat messages", async () => {
    const lines = [
      makeEntry("user", "HEARTBEAT_OK", 5),
      makeEntry("assistant", "NO_REPLY", 5),
      makeEntry("user", "Real question", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Real question/);
  });

  it("filters observer output (self-observation)", async () => {
    const lines = [
      makeEntry("assistant", "OBSERVATIONS_ADDED — compressed 5 messages", 5),
      makeEntry("user", "Normal user message", 5),
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Normal user message/);
  });

  it("respects maxSessions limit", async () => {
    // Create 5 session files, all with recent messages
    const storeEntries: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(sessionsDir, `session-${i}.jsonl`),
        makeEntry("user", `Message from session ${i}`, 5),
        "utf8"
      );
      storeEntries[`session-${i}`] = `user:chat:session-${i}`;
    }
    await writeSessionStore(sessionsDir, storeEntries);

    const config = {
      ...DEFAULTS,
      observer: { ...DEFAULTS.observer, maxSessions: 3 },
    };
    const result = await readRecentSessions(sessionsDir, config, {
      lookbackMinutes: 15,
    });
    // Should only scan 3 sessions
    expect(result.sessionFiles.length).toBeLessThanOrEqual(3);
  });

  it("respects maxLinesPerTranscript limit", async () => {
    // Create a file with many lines — only last N should be read
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      // Put old messages first (outside window)
      lines.push(makeEntry("user", `Old message ${i}`, 60));
    }
    // Only last 10 lines are within the window
    for (let i = 0; i < 10; i++) {
      lines.push(makeEntry("user", `Recent message ${i}`, 5));
    }
    await writeFile(join(sessionsDir, "long.jsonl"), lines.join("\n"), "utf8");
    await writeSessionStore(sessionsDir, { long: "user:chat:abc" });

    const config = {
      ...DEFAULTS,
      observer: { ...DEFAULTS.observer, maxLinesPerTranscript: 20 },
    };
    const result = await readRecentSessions(sessionsDir, config, {
      lookbackMinutes: 15,
    });
    // maxLinesPerTranscript=20 means we only read last 20 lines
    // Those 20 lines contain 10 recent messages
    expect(result.messages).toHaveLength(10);
  });

  it("uses specific session file in recover mode", async () => {
    const recoverFile = join(sessionsDir, "recover-target.jsonl");
    await writeFile(
      recoverFile,
      makeEntry("user", "Recovered message", 5),
      "utf8"
    );
    // Also create another session — should NOT be read in recover mode
    await writeFile(
      join(sessionsDir, "other.jsonl"),
      makeEntry("user", "Other session message", 5),
      "utf8"
    );

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 240,
      recoverSessionPath: recoverFile,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Recovered message/);
    expect(result.sessionFiles).toEqual([recoverFile]);
    expect(result.sessionKeys).toEqual([]);
    expect(result.messages[0]).toContain(`[session=${UNRESOLVED_RECOVERY_SESSION_KEY}]`);
  });

  it("handles array content format", async () => {
    const entry = JSON.stringify({
      timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "Array content message" },
          { type: "image", data: "..." },
        ],
      },
    });
    await writeFile(join(sessionsDir, "main.jsonl"), entry, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Array content message/);
  });

  it("strips channel metadata wrappers from Discord messages before truncating", async () => {
    const discordContent = [
      "Conversation info (untrusted metadata): {\"channel\":\"discord\",\"guild\":\"Lenny\"}",
      "Sender (untrusted metadata): {\"id\":\"123\",\"name\":\"Mike\"}",
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="msg-001">>>',
      "What is the status of the build pipeline right now?",
      "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
    ].join("\n");
    await writeFile(
      join(sessionsDir, "discord.jsonl"),
      makeEntry("user", discordContent, 5),
      "utf8"
    );
    await writeSessionStore(sessionsDir, { discord: "user:chat:discord" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    // Should contain the real message, not the metadata preamble
    expect(result.messages[0]).toMatch(/What is the status of the build pipeline/);
    expect(result.messages[0]).not.toMatch(/untrusted metadata/);
    expect(result.messages[0]).not.toMatch(/EXTERNAL_UNTRUSTED_CONTENT/);
  });

  it("handles malformed JSONL lines gracefully", async () => {
    const lines = [
      "not json at all {{{",
      makeEntry("user", "Valid message", 5),
      '{"incomplete":',
    ].join("\n");
    await writeFile(join(sessionsDir, "main.jsonl"), lines, "utf8");
    await writeSessionStore(sessionsDir, { main: "user:chat:abc" });

    const result = await readRecentSessions(sessionsDir, DEFAULTS, {
      lookbackMinutes: 15,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/Valid message/);
  });

  it("resolves the stable session key for a stored session file", async () => {
    await writeSessionStore(sessionsDir, { "discord-session": "agent:main:discord:channel:123" });
    expect(
      await resolveSessionKeyForPath(sessionsDir, join(sessionsDir, "discord-session.jsonl"))
    ).toBe("agent:main:discord:channel:123");
  });
});
