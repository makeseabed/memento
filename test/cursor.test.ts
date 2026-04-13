import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLastObservedAt, writeLastObservedAt } from "../src/utils/cursor.js";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "memento-cursor-test-"));
  await mkdir(join(workspaceDir, "memento", "shared"), { recursive: true });
});

async function cleanup() {
  await rm(workspaceDir, { recursive: true, force: true });
}

describe("readLastObservedAt", () => {
  it("returns ~2 hours ago when cursor file does not exist", async () => {
    const before = Date.now();
    const date = await readLastObservedAt(workspaceDir);
    const after = Date.now();

    const twoHoursMs = 2 * 60 * 60 * 1000;
    expect(date.getTime()).toBeGreaterThanOrEqual(before - twoHoursMs - 100);
    expect(date.getTime()).toBeLessThanOrEqual(after - twoHoursMs + 100);
    await cleanup();
  });

  it("returns the stored timestamp when cursor file exists", async () => {
    const ts = "2026-04-01T10:00:00.000Z";
    await writeFile(join(workspaceDir, "memento", "shared", "last-observed-at"), ts, "utf8");

    const date = await readLastObservedAt(workspaceDir);
    expect(date.toISOString()).toBe(ts);
    await cleanup();
  });

  it("falls back to 2 hours ago when cursor file contains invalid content", async () => {
    await writeFile(join(workspaceDir, "memento", "shared", "last-observed-at"), "not-a-date", "utf8");

    const before = Date.now();
    const date = await readLastObservedAt(workspaceDir);
    const after = Date.now();

    const twoHoursMs = 2 * 60 * 60 * 1000;
    expect(date.getTime()).toBeGreaterThanOrEqual(before - twoHoursMs - 100);
    expect(date.getTime()).toBeLessThanOrEqual(after - twoHoursMs + 100);
    await cleanup();
  });
});

describe("writeLastObservedAt", () => {
  it("writes a valid ISO timestamp to the cursor file", async () => {
    const before = new Date();
    await writeLastObservedAt(workspaceDir);
    const after = new Date();

    const written = await readLastObservedAt(workspaceDir);
    expect(written.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(written.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
    await cleanup();
  });

  it("overwrites a previous cursor value", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    await writeFile(join(workspaceDir, "memento", "shared", "last-observed-at"), old, "utf8");

    await writeLastObservedAt(workspaceDir);

    const written = await readLastObservedAt(workspaceDir);
    expect(written.getTime()).toBeGreaterThan(new Date(old).getTime());
    await cleanup();
  });

  it("creates the cursor directory on first write", async () => {
    await rm(join(workspaceDir, "memento", "shared"), { recursive: true, force: true });

    await expect(writeLastObservedAt(workspaceDir)).resolves.toBeUndefined();

    const written = await readLastObservedAt(workspaceDir);
    expect(Number.isNaN(written.getTime())).toBe(false);
    await cleanup();
  });
});
