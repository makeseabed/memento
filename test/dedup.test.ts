import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeHash,
  readObserverState,
  writeObserverState,
  checkPreLLMDedup,
  fingerprint,
  buildExistingFingerprints,
  deduplicateObservations,
} from "../src/observer/dedup.js";

describe("computeHash", () => {
  it("returns a hex string", () => {
    const h = computeHash("hello");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it("same content produces same hash", () => {
    expect(computeHash("abc")).toBe(computeHash("abc"));
  });

  it("different content produces different hash", () => {
    expect(computeHash("abc")).not.toBe(computeHash("xyz"));
  });
});

describe("readObserverState / writeObserverState", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-dedup-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    stateFile = join(tmpDir, ".observer-state.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when file does not exist", async () => {
    const state = await readObserverState(stateFile);
    expect(state).toEqual({});
  });

  it("round-trips state correctly", async () => {
    const state = { "session-a|session-b": "abc123", "session-c": "def456" };
    await writeObserverState(stateFile, state);
    const loaded = await readObserverState(stateFile);
    expect(loaded).toEqual(state);
  });

  it("returns empty object on malformed JSON", async () => {
    await writeFile(stateFile, "not json", "utf8");
    const state = await readObserverState(stateFile);
    expect(state).toEqual({});
  });

  it("creates parent directories if needed", async () => {
    const nestedPath = join(tmpDir, "nested", "deep", "state.json");
    await writeObserverState(nestedPath, { key: "value" });
    const loaded = await readObserverState(nestedPath);
    expect(loaded).toEqual({ key: "value" });
  });
});

describe("checkPreLLMDedup", () => {
  it("returns changed=true when no prior state", () => {
    const result = checkPreLLMDedup(["msg1", "msg2"], ["session-a.jsonl"], {});
    expect(result.changed).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.compositeKey).toBe("session-a.jsonl");
  });

  it("returns changed=false when hash matches", () => {
    const messages = ["msg1", "msg2"];
    const files = ["session-a.jsonl"];
    const first = checkPreLLMDedup(messages, files, {});
    const state = { [first.compositeKey]: first.hash };
    const second = checkPreLLMDedup(messages, files, state);
    expect(second.changed).toBe(false);
  });

  it("returns changed=true when messages differ", () => {
    const files = ["session-a.jsonl"];
    const first = checkPreLLMDedup(["msg1"], files, {});
    const state = { [first.compositeKey]: first.hash };
    const second = checkPreLLMDedup(["msg1", "msg2_new"], files, state);
    expect(second.changed).toBe(true);
  });

  it("produces stable compositeKey regardless of file order", () => {
    const r1 = checkPreLLMDedup(["m"], ["b.jsonl", "a.jsonl"], {});
    const r2 = checkPreLLMDedup(["m"], ["a.jsonl", "b.jsonl"], {});
    expect(r1.compositeKey).toBe(r2.compositeKey);
  });
});

describe("fingerprint", () => {
  it("strips bullet and emoji", () => {
    const fp = fingerprint("  - 🔴 Some observation here");
    expect(fp).not.toMatch(/🔴/);
    expect(fp).not.toMatch(/^-/);
    expect(fp.trim()).toBe("Some observation here");
  });

  it("strips markdown bold", () => {
    const fp = fingerprint("- 🟡 **Important** decision was made");
    expect(fp).not.toContain("**");
    expect(fp).toContain("Important");
  });

  it("strips ISO dates", () => {
    const fp = fingerprint("- 🟢 2026-03-31 something happened");
    expect(fp).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("strips day names", () => {
    const fp = fingerprint("- 🔴 Monday meeting was held");
    expect(fp).not.toMatch(/Monday/i);
    expect(fp).toContain("meeting was held");
  });

  it("collapses whitespace", () => {
    const fp = fingerprint("- 🟢  multiple   spaces   here");
    expect(fp).not.toMatch(/  /);
  });

  it("truncates to 80 chars", () => {
    const longLine = "- 🔴 " + "x".repeat(200);
    const fp = fingerprint(longLine);
    expect(fp.length).toBeLessThanOrEqual(80);
  });
});

describe("buildExistingFingerprints", () => {
  it("returns empty set for empty content", () => {
    const fps = buildExistingFingerprints("");
    expect(fps.size).toBe(0);
  });

  it("extracts fingerprints from bullet lines only", () => {
    const content = `## 2026-03-31

- 🔴 Important decision was made
- 🟡 Medium priority item here
Not a bullet line — should be ignored
## Another section

- 🟢 Low priority item`;
    const fps = buildExistingFingerprints(content);
    expect(fps.size).toBe(3);
  });

  it("ignores non-bullet lines", () => {
    const content = "## Header\nSome prose text\nAnother line";
    const fps = buildExistingFingerprints(content);
    expect(fps.size).toBe(0);
  });
});

describe("deduplicateObservations", () => {
  it("returns original output when existingFingerprints is empty (guard)", () => {
    const output = "- 🔴 New observation here\n- 🟡 Another one";
    const { dedupedOutput, allDeduped } = deduplicateObservations(output, new Set());
    expect(dedupedOutput).toBe(output);
    expect(allDeduped).toBe(false);
  });

  it("filters duplicate observations", () => {
    const existingContent = "- 🔴 Important decision was made";
    const fps = buildExistingFingerprints(existingContent);

    const llmOutput = `- 🔴 Important decision was made <!-- dc:type=decision -->
- 🟡 Brand new observation here <!-- dc:type=event -->`;

    const { dedupedOutput, allDeduped } = deduplicateObservations(llmOutput, fps);
    expect(dedupedOutput).not.toMatch(/Important decision/);
    expect(dedupedOutput).toMatch(/Brand new observation/);
    expect(allDeduped).toBe(false);
  });

  it("sets allDeduped=true when all bullets are duplicates", () => {
    const existingContent = "- 🔴 Same observation\n- 🟡 Another same one";
    const fps = buildExistingFingerprints(existingContent);

    const llmOutput = "- 🔴 Same observation <!-- dc:type=decision -->\n- 🟡 Another same one <!-- dc:type=event -->";
    const { allDeduped } = deduplicateObservations(llmOutput, fps);
    expect(allDeduped).toBe(true);
  });

  it("preserves non-bullet lines (date headers, blank lines)", () => {
    const fps = new Set(["some existing fingerprint"]);
    const llmOutput = `Date: 2026-03-31

- 🔴 New unique observation here

`;
    const { dedupedOutput } = deduplicateObservations(llmOutput, fps);
    expect(dedupedOutput).toMatch(/New unique observation/);
  });
});
