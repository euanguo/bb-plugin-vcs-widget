// Fixed-height row windowing, so a log of thousands of commits renders a
// screenful of DOM nodes. Pure arithmetic: the panel supplies the scroll
// offset and the viewport height it measured, and renders the returned slice
// between two spacer divs.

export interface VirtualWindow {
  /** First row to render (inclusive). */
  start: number;
  /** Last row to render (exclusive). */
  end: number;
  /** Pixels of spacer above the rendered slice. */
  topPadding: number;
  /** Pixels of spacer below it. */
  bottomPadding: number;
}

export interface VirtualInput {
  scrollTop: number;
  /** 0 before the container has been measured. */
  viewportHeight: number;
  rowHeight: number;
  count: number;
  /** Rows kept on either side of the viewport so scrolling does not flash. */
  overscan?: number;
}

/** Rows rendered before the viewport has been measured, so the first paint has content. */
export const UNMEASURED_ROWS = 40;

export function visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan = 8 }: VirtualInput): VirtualWindow {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0 || rowHeight <= 0) return { start: 0, end: total, topPadding: 0, bottomPadding: 0 };
  const window = (start: number, end: number): VirtualWindow => ({
    start,
    end,
    topPadding: start * rowHeight,
    bottomPadding: (total - end) * rowHeight,
  });
  if (viewportHeight <= 0) return window(0, Math.min(total, UNMEASURED_ROWS));
  const offset = Math.max(0, scrollTop);
  const first = Math.floor(offset / rowHeight) - overscan;
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;
  const start = Math.max(0, Math.min(first, total));
  return window(start, Math.min(total, start + visible));
}

/**
 * The `scrollTop` that brings one row into view, moving the container as
 * little as it can. A row already fully visible is left alone, which is what
 * makes the keyboard walk a list without the list jumping under it.
 *
 * The caller sets `scrollTop` and the row index in the same update, so the
 * window the next render computes from the new offset already contains the
 * row. Doing it the other way round — move the highlight, then scroll in an
 * effect — leaves one paint where the highlighted row is not mounted.
 */
export function scrollTopForRow({
  index,
  rowHeight,
  scrollTop,
  viewportHeight,
}: {
  index: number;
  rowHeight: number;
  scrollTop: number;
  /** 0 before the container has been measured. */
  viewportHeight: number;
}): number {
  if (index < 0 || rowHeight <= 0) return Math.max(0, scrollTop);
  const offset = Math.max(0, scrollTop);
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  // Unmeasured: put the row at the top rather than guess at a viewport.
  if (viewportHeight <= 0) return top;
  if (top < offset) return top;
  if (bottom > offset + viewportHeight) return bottom - viewportHeight;
  return offset;
}

