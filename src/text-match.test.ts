import { test, expect, describe } from "bun:test";
import { foldForMatch, containsFolded, equalsFolded } from "./text-match";

describe("foldForMatch", () => {
  test("folds non-ASCII case, which SQLite's LOWER() leaves untouched", () => {
    expect(foldForMatch("MÖTE")).toBe("möte");
    expect(foldForMatch("Åtgärder")).toBe("åtgärder");
    expect(foldForMatch("MEETING")).toBe("meeting");
  });

  test("normalizes to NFC so a decomposed umlaut equals a precomposed one", () => {
    const decomposed = "mo\u0308te";
    const precomposed = "m\u00f6te";
    expect(decomposed).not.toBe(precomposed);
    expect(foldForMatch(decomposed)).toBe(foldForMatch(precomposed));
  });
});

describe("containsFolded", () => {
  test("matches regardless of case for non-ASCII characters", () => {
    expect(containsFolded("Åtgärder", "åtgärder")).toBe(true);
    expect(containsFolded("nästa möte", "MÖTE")).toBe(true);
  });

  test("treats LIKE metacharacters as literal text", () => {
    expect(containsFolded("Discount 50% off", "50%")).toBe(true);
    expect(containsFolded("5000 widgets", "50%")).toBe(false);
    expect(containsFolded("file_name", "file_name")).toBe(true);
    expect(containsFolded("filexname", "file_name")).toBe(false);
  });
});

describe("equalsFolded", () => {
  test("is exact apart from case and normalization", () => {
    expect(equalsFolded("möte", "MÖTE")).toBe(true);
    expect(equalsFolded("work", "homework")).toBe(false);
    expect(equalsFolded("mo\u0308te", "m\u00f6te")).toBe(true);
  });
});
