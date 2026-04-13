import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ObserverState {
  [compositeKey: string]: string; // compositeKey -> MD5 hash
}

interface ObserverStateFile {
  hashes: ObserverState;
}

export function computeHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export async function readObserverState(stateFilePath: string): Promise<ObserverState> {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as ObserverStateFile;
    return parsed.hashes ?? {};
  } catch {
    return {};
  }
}

export async function writeObserverState(
  stateFilePath: string,
  state: ObserverState
): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, JSON.stringify({ hashes: state }, null, 2), "utf8");
}

export function checkPreLLMDedup(
  messages: string[],
  sessionFiles: string[],
  existingState: ObserverState
): { changed: boolean; hash: string; compositeKey: string } {
  const content = messages.join("\n");
  const hash = computeHash(content);
  // Stable key from sorted session files
  const compositeKey = [...sessionFiles].sort().join("|");
  const lastHash = existingState[compositeKey];
  return {
    changed: lastHash !== hash,
    hash,
    compositeKey,
  };
}

const BULLET_LINE_RE = /^\s*-\s*[🔴🟡🟢]/u;

/**
 * Compute a dedup fingerprint for a single observation line.
 * Strips bullets/emoji/timestamps/dates/day-names/markdown bold,
 * collapses whitespace, takes first 80 chars.
 */
export function fingerprint(line: string): string {
  return line
    .replace(/^\s*-\s*[🔴🟡🟢]\s*/u, "") // strip bullet + priority emoji
    .replace(/<!--.*?-->/gs, "") // strip HTML metadata tags (dc:type etc.)
    .replace(/\*\*/g, "") // strip markdown bold
    .replace(/\d{4}-\d{2}-\d{2}/g, "") // strip ISO dates
    .replace(
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi,
      ""
    ) // strip day names
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function buildExistingFingerprints(observationsContent: string): Set<string> {
  const fps = new Set<string>();
  for (const line of observationsContent.split("\n")) {
    if (!BULLET_LINE_RE.test(line)) continue;
    const fp = fingerprint(line);
    if (fp) fps.add(fp);
  }
  return fps;
}

export interface DedupeResult {
  dedupedOutput: string;
  /** True if every bullet line was a duplicate — no new observations remain */
  allDeduped: boolean;
}

export function deduplicateObservations(
  llmOutput: string,
  existingFingerprints: Set<string>
): DedupeResult {
  // Guard: if no existing fingerprints, skip filter entirely
  if (existingFingerprints.size === 0) {
    return { dedupedOutput: llmOutput, allDeduped: false };
  }

  const lines = llmOutput.split("\n");
  const result: string[] = [];
  let bulletCount = 0;
  let skippedCount = 0;

  for (const line of lines) {
    if (BULLET_LINE_RE.test(line)) {
      bulletCount++;
      const fp = fingerprint(line);
      if (fp && existingFingerprints.has(fp)) {
        skippedCount++;
        continue; // drop duplicate
      }
    }
    result.push(line);
  }

  const dedupedOutput = result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const allDeduped = bulletCount > 0 && skippedCount === bulletCount;
  return { dedupedOutput, allDeduped };
}
