import { describe, expect, it } from "vitest";
import { DIFF_LINE_HEIGHT_PX, estimateDiffBodyHeight, NOTICE_BODY_HEIGHT_PX } from "./diff-height";

describe("estimateDiffBodyHeight", () => {
  it("counts one line height per rendered line", () => {
    expect(estimateDiffBodyHeight(2)).toBe(2 * DIFF_LINE_HEIGHT_PX + 8);
    expect(estimateDiffBodyHeight(40)).toBe(40 * DIFF_LINE_HEIGHT_PX + 8);
  });

  it("never guesses less than one line, so a placeholder is never zero tall", () => {
    expect(estimateDiffBodyHeight(0)).toBe(DIFF_LINE_HEIGHT_PX + 8);
    expect(estimateDiffBodyHeight(-3)).toBe(DIFF_LINE_HEIGHT_PX + 8);
  });

  it("keeps the notice taller than a single line, so a text row is not crushed", () => {
    expect(NOTICE_BODY_HEIGHT_PX).toBeGreaterThan(DIFF_LINE_HEIGHT_PX);
  });
});
