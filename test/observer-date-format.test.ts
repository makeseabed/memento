import { describe, expect, it } from "vitest";

import {
  formatObserverDate,
  formatObserverDateParts,
  formatObserverTime,
} from "../src/observer/date-format.js";

describe("observer date formatting", () => {
  const sampleDate = new Date("2026-04-07T11:26:00.000Z");

  it("formats observer dates in a canonical YYYY-MM-DD form", () => {
    expect(formatObserverDate(sampleDate, "Europe/Copenhagen")).toBe("2026-04-07");
    expect(formatObserverDate(sampleDate, "UTC")).toBe("2026-04-07");
  });

  it("formats observer times in 24-hour HH:MM form", () => {
    expect(formatObserverTime(sampleDate, "Europe/Copenhagen")).toBe("13:26");
    expect(formatObserverTime(sampleDate, "UTC")).toBe("11:26");
  });

  it("returns the shared observer prompt parts together", () => {
    expect(formatObserverDateParts(sampleDate, "Europe/Copenhagen")).toEqual({
      timeZone: "Europe/Copenhagen",
      date: "2026-04-07",
      dayName: "Tuesday",
      time: "13:26",
    });
  });
});
