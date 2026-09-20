// The changed-file pane's width, which the splitter drags.
//
// Pure and separate because it is the one part of the drag worth testing: the
// rest is a pointer listener that writes to the DOM, and in a unit test there
// is no layout to drag against.
import { PANE_WIDTH } from "./constants";

/**
 * The width the pane should take for a pointer at `clientX`, given the right
 * edge of the split it lives in. Clamped at both ends so the drag cannot
 * collapse the file list to nothing or push the diff pane off the panel.
 */
export function paneWidthForPointer(rightEdge: number, clientX: number): number {
  return Math.min(PANE_WIDTH.max, Math.max(PANE_WIDTH.min, rightEdge - clientX));
}
