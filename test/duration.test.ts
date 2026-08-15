import { describe, expect, test } from "bun:test";
import { compactDuration } from "../src/duration";

describe("compact duration", () => {
  test("uses compact minute and hour formatting", () => {
    expect(compactDuration(0)).toBe("now");
    expect(compactDuration(59_000)).toBe("1m");
    expect(compactDuration(59 * 60_000)).toBe("59m");
    expect(compactDuration(60 * 60_000)).toBe("1h");
    expect(compactDuration((23 * 60 + 15) * 60_000)).toBe("23h 15m");
  });

  test("switches to days at the 24-hour boundary", () => {
    expect(compactDuration(24 * 60 * 60_000)).toBe("1d");
    expect(compactDuration((24 * 60 + 30) * 60_000)).toBe("1d 30m");
    expect(compactDuration(25 * 60 * 60_000)).toBe("1d 1h");
    expect(compactDuration((5 * 24 + 9) * 60 * 60_000)).toBe("5d 9h");
  });
});
