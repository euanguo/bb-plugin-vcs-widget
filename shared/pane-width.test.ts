import { describe, expect, it } from "vitest";
import { PANE_WIDTH } from "./constants";
import { paneWidthForPointer } from "./pane-width";

describe("paneWidthForPointer", () => {
  const rightEdge = 1000;

  it("measures the gap between the pointer and the panel's right edge", () => {
    expect(paneWidthForPointer(rightEdge, 600)).toBe(400);
    expect(paneWidthForPointer(rightEdge, 700)).toBe(300);
  });

  it("stops at the wider end rather than eating the diff pane", () => {
    expect(paneWidthForPointer(rightEdge, 100)).toBe(PANE_WIDTH.max);
    expect(paneWidthForPointer(rightEdge, 0)).toBe(PANE_WIDTH.max);
  });

  it("stops at the narrower end rather than collapsing the list", () => {
    expect(paneWidthForPointer(rightEdge, 900)).toBe(PANE_WIDTH.min);
    expect(paneWidthForPointer(rightEdge, 1200)).toBe(PANE_WIDTH.min);
  });

  it("keeps both bounds exactly reachable", () => {
    expect(paneWidthForPointer(rightEdge, rightEdge - PANE_WIDTH.max)).toBe(PANE_WIDTH.max);
    expect(paneWidthForPointer(rightEdge, rightEdge - PANE_WIDTH.min)).toBe(PANE_WIDTH.min);
  });

  it("passes a fractional pointer through unchanged", () => {
    // Device pixel ratios mean clientX is not always an integer, and rounding
    // here would make a slow drag stutter.
    expect(paneWidthForPointer(1000, 600.5)).toBe(399.5);
  });
});
