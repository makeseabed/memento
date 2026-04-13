import { describe, expect, it } from "vitest";

import { OBSERVER_SYSTEM_PROMPT, buildObserverUserPrompt } from "../src/observer/prompts.js";

describe("OBSERVER_SYSTEM_PROMPT", () => {
  it("preserves scope routing requirements", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain("dc:scope=shared");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("dc:scope=session dc:session=");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("## IMPORTANT: Scope Classification Rules");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Decide scope FIRST, before type or importance");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("likely to remain broadly useful across future conversations in general");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Shared is the narrower bucket. Session is the default bucket.");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Important, durable, or high-priority does NOT automatically mean shared");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Many important observations should still stay session-scoped");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Prefer session for thread-local plans, temporary investigations, progress updates, local decisions, follow-ups, and context that should not leak into unrelated future chats");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("If dc:session is present on a bullet, dc:scope=session MUST also be present on that same bullet. They always go together.");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Never output dc:scope=session without dc:session");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Never output dc:session without dc:scope=session");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("If unsure, prefer session over shared");
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
      "UTC"
    );

    expect(prompt).toContain("Today is 2026-04-07 (Tuesday), current time is 11:26.");
  });
});
