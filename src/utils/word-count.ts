import { readFile } from "node:fs/promises";

export async function shouldReflect(
  observationsPath: string,
  threshold: number
): Promise<boolean> {
  try {
    const content = await readFile(observationsPath, "utf8");
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    return wordCount >= threshold;
  } catch {
    return false;
  }
}
