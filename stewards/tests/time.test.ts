import { describe, expect, it } from "vitest";
import { agoText, fullDate, exactText } from "../../web/src/time.js";

const now = Date.UTC(2026, 10, 19, 12, 0, 0);
describe("relative times", () => {
  it("says seconds, minutes, hours and days ago", () => {
    expect(agoText(now - 2_000, now)).toBe("just now");
    expect(agoText(now - 12_000, now)).toBe("12s ago");
    expect(agoText(now - 5 * 60_000, now)).toBe("5m ago");
    expect(agoText(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(agoText(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(agoText(now - 6 * 86_400_000 - 3_600_000, now)).toBe("6d ago");
  });
  it("writes the date itself from 7 days on", () => {
    expect(agoText(now - 7 * 86_400_000, now)).toBe("12 Nov 2026");
    expect(fullDate(Date.UTC(2026, 0, 3))).toBe("3 Jan 2026");
  });
  it("says 'in' for times ahead", () => {
    expect(agoText(now + 40_000, now)).toBe("in 40s");
    expect(agoText(now + 2 * 3_600_000, now)).toBe("in 2h");
  });
  it("keeps the exact UTC time for the tooltip", () => {
    expect(exactText(Date.UTC(2026, 10, 19, 3, 36, 2))).toBe("19 Nov 2026, 03:36:02 UTC");
  });
});
