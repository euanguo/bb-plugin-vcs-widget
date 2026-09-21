import { describe, expect, it } from "vitest";
import { DIFF_LINE_HEIGHT_PX, IMAGE_BODY_HEIGHT_PX, NOTICE_BODY_HEIGHT_PX, ROW_GAP_PX, ROW_HEADER_HEIGHT_PX, estimateRowHeight } from "./row-height";

const row = (extra: Partial<Parameters<typeof estimateRowHeight>[0]> = {}) =>
  estimateRowHeight({ collapsed: false, changedLines: 10, binary: false, image: false, ...extra });

describe("estimateRowHeight", () => {
  it("is the header alone while the row is collapsed", () => {
    expect(row({ collapsed: true, changedLines: 500 })).toBe(ROW_HEADER_HEIGHT_PX);
  });

  it("grows with the change size, so rows do not all start out the same height", () => {
    const small = row({ changedLines: 2 });
    const large = row({ changedLines: 200 });
    expect(large - small).toBe(198 * DIFF_LINE_HEIGHT_PX);
    expect(small).toBe(ROW_HEADER_HEIGHT_PX + 2 * DIFF_LINE_HEIGHT_PX + 8 + ROW_GAP_PX);
  });

  it("falls back to a notice for a file git did not count", () => {
    expect(row({ changedLines: null })).toBe(ROW_HEADER_HEIGHT_PX + NOTICE_BODY_HEIGHT_PX + ROW_GAP_PX);
    expect(row({ changedLines: 0 })).toBe(ROW_HEADER_HEIGHT_PX + NOTICE_BODY_HEIGHT_PX + ROW_GAP_PX);
  });

  it("uses a picture for a previewable binary and a notice for any other", () => {
    expect(row({ binary: true, image: true, changedLines: 10 })).toBe(ROW_HEADER_HEIGHT_PX + IMAGE_BODY_HEIGHT_PX + ROW_GAP_PX);
    expect(row({ binary: true, image: false, changedLines: 10 })).toBe(ROW_HEADER_HEIGHT_PX + NOTICE_BODY_HEIGHT_PX + ROW_GAP_PX);
  });
});
