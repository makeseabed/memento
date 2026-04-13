import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupObservations } from "../src/reflector/backup.js";

describe("backupObservations", () => {
  let tmpDir: string;
  let observationsPath: string;
  let backupDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memento-backup-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    observationsPath = join(tmpDir, "observations.md");
    backupDir = join(tmpDir, "backups");
    await writeFile(observationsPath, "# Observations\n\nSome content here.", "utf8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a backup file in the backup directory", async () => {
    const backupPath = await backupObservations(observationsPath, backupDir, 10);

    const files = await readdir(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^observations-.*\.md$/);
    expect(backupPath).toContain("observations-");
    expect(backupPath).toContain(backupDir);
  });

  it("backup file contains the same content as the source", async () => {
    const { readFile } = await import("node:fs/promises");
    const backupPath = await backupObservations(observationsPath, backupDir, 10);
    const backupContent = await readFile(backupPath, "utf8");
    expect(backupContent).toBe("# Observations\n\nSome content here.");
  });

  it("creates the backup directory if it does not exist", async () => {
    const newBackupDir = join(tmpDir, "new-backup-dir");
    await backupObservations(observationsPath, newBackupDir, 10);
    const files = await readdir(newBackupDir);
    expect(files).toHaveLength(1);
  });

  it("prunes to the last N backups when retention count is exceeded", async () => {
    // Create 12 pre-existing backups with known timestamps
    await mkdir(backupDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      const name = `observations-2026-01-${String(i).padStart(2, "0")}T00-00-00.000Z.md`;
      await writeFile(join(backupDir, name), `backup ${i}`, "utf8");
    }

    await backupObservations(observationsPath, backupDir, 10);

    const files = await readdir(backupDir);
    expect(files).toHaveLength(10);
  });

  it("does not prune when backup count is within retention limit", async () => {
    await mkdir(backupDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      const name = `observations-2026-01-${String(i).padStart(2, "0")}T00-00-00.000Z.md`;
      await writeFile(join(backupDir, name), `backup ${i}`, "utf8");
    }

    await backupObservations(observationsPath, backupDir, 10);

    const files = await readdir(backupDir);
    expect(files).toHaveLength(6); // 5 existing + 1 new
  });

  it("keeps the most recent backups when pruning", async () => {
    await mkdir(backupDir, { recursive: true });
    // Create 11 backups, sorted newest will be kept
    for (let i = 1; i <= 11; i++) {
      const name = `observations-2026-01-${String(i).padStart(2, "0")}T00-00-00.000Z.md`;
      await writeFile(join(backupDir, name), `backup ${i}`, "utf8");
    }

    await backupObservations(observationsPath, backupDir, 10);

    const files = (await readdir(backupDir)).sort();
    // The oldest one (2026-01-01) should have been pruned
    // along with 2026-01-02, keeping 2026-01-03 through the new backup
    expect(files[0]).not.toMatch(/2026-01-01/);
  });

  it("returns the path to the new backup file", async () => {
    const result = await backupObservations(observationsPath, backupDir, 10);
    expect(result).toMatch(/observations-.*\.md$/);
    // Verify the file actually exists
    const { access } = await import("node:fs/promises");
    await expect(access(result)).resolves.toBeUndefined();
  });
});
