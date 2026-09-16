// Vitest runs outside the bb host that normally provides @pierre/diffs/react
// as a runtime shim, and the real renderer needs a shadow root, a worker pool
// and measured layout. This stand-in keeps the one part the plugin talks to —
// the gutter utility renderer — so a test can click the "+" and see exactly
// what would be quoted. Parsing stays real: @pierre/diffs is pure.
import type { CSSProperties, ReactElement, ReactNode } from "react";

export type DiffLineSide = "additions" | "deletions";

export interface SelectedLineRange {
  start: number;
  end: number;
  side?: DiffLineSide | null;
  endSide?: DiffLineSide | null;
}

export const GutterUtilitySlotStyles: CSSProperties = {};

/** The line the stand-in reports as hovered; a test can move it. */
export const hovered: { line: { lineNumber: number; side: DiffLineSide } } = {
  line: { lineNumber: 1, side: "additions" },
};

interface FileDiffProps {
  fileDiff: { name: string };
  options?: unknown;
  renderGutterUtility?: (getHoveredLine: () => { lineNumber: number; side: DiffLineSide } | undefined) => ReactNode;
}

export function FileDiff({ fileDiff, renderGutterUtility }: FileDiffProps): ReactElement {
  return (
    <div data-testid={"pierre-diff-" + fileDiff.name}>
      {renderGutterUtility === undefined ? null : renderGutterUtility(() => hovered.line)}
    </div>
  );
}

