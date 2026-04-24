import { describe, expect, it } from "vitest";

import { OBSERVER_SYSTEM_PROMPT, buildObserverUserPrompt } from "../src/observer/prompts.js";

describe("OBSERVER_SYSTEM_PROMPT", () => {
  it("uses session tagging plus type-based routing", () => {
    expect(OBSERVER_SYSTEM_PROMPT).not.toContain("dc:scope=");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("dc:session=session-key");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Use the exact session key from the `[session=...]` marker");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("dc:type=rule");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("MUST be exactly one of these values");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Do not invent new type values");
  });

  it("restores the stronger priority, temporal, and dedup guidance", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain("🔴 = 6-10, 🟡 = 3-6, 🟢 = 0-3");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Do not ignore 🟢 items");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("the absolute date");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("the relative offset");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("When in doubt, it is a duplicate. Skip it.");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Skip: quoted or repeated historical content unless the current conversation adds a new fact");
  });
});

describe("buildObserverUserPrompt", () => {
  it("uses the shared canonical observer date/time format", () => {
    const prompt = buildObserverUserPrompt(
      ["[13:26] [session=user:chat:abc] USER: Hello"],
      "",
      new Date("2026-04-07T11:26:00.000Z"),
      ["user:chat:abc"],
      "UTC"
    );

    expect(prompt).toContain("Today is 2026-04-07 (Tuesday), current time is 11:26.");
    expect(prompt).toContain("Valid session keys for this batch:");
    expect(prompt).toContain("- user:chat:abc");
    expect(prompt).toContain("Every bullet must include dc:session with one of the keys above.");
  });
});
