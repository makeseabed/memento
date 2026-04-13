import { copyFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Creates a timestamped backup of observations.md and prunes old backups.
 * Returns the path of the new backup file.
 */
export async function backupObservations(
  observationsPath: string,
  backupDir: string,
  retentionCount: number
): Promise<string> {
  await mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const backupPath = join(backupDir, `observations-${timestamp}.md`);

  await copyFile(observationsPath, backupPath);

  // Prune old backups — ISO timestamps sort lexicographically, oldest first
  const files = await readdir(backupDir);
  const backupFiles = files
    .filter((f) => f.startsWith("observations-") && f.endsWith(".md"))
    .sort();

  const excess = backupFiles.length - retentionCount;
  if (excess > 0) {
    for (const f of backupFiles.slice(0, excess)) {
      try {
        await unlink(join(backupDir, f));
      } catch {
        // best-effort
      }
    }
  }

  return backupPath;
}
