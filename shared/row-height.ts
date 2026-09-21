// How tall a row of the diff stream is, before its diff has been measured.
//
// The stream is windowed over rows whose heights differ: a file row is a
// header plus a body, and the body is a diff whose height depends on how many
// lines it renders. So the virtualizer needs a first estimate per row, and
// the estimate has to come from what the row already knows -- the change
// size git reported -- rather than from a fixed number, or every row would
// start out the same height and the scrollbar would lurch as each one is
// measured.
//
// A collapsed row is its header alone. A binary row is its notice or its
// image preview. A textual row is its header, its padding and its lines.

/** The line height the renderer is configured with, in the plugin's frame style. */
export const DIFF_LINE_HEIGHT_PX = 18;

/** Padding the renderer adds around the lines. */
export const DIFF_BODY_PADDING_PX = 8;

/** A row header: the chevron, the status letter, the path and the tag. */
export const ROW_HEADER_HEIGHT_PX = 26;

/** A one-line notice: the `px-3 py-3` padding around a `text-xs` line. */
export const NOTICE_BODY_HEIGHT_PX = 36;

/** An image preview, whose own component sets a taller frame. */
export const IMAGE_BODY_HEIGHT_PX = 160;

/** The gap between two rows, which the stream draws as a border. */
export const ROW_GAP_PX = 1;

/**
 * The height of a diff body of `lineCount` rendered lines.
 */
export function estimateDiffBodyHeight(lineCount: number): number {
  return Math.max(1, Math.trunc(lineCount)) * DIFF_LINE_HEIGHT_PX + DIFF_BODY_PADDING_PX;
}

/** What one row knows before its diff has been read. */
export interface RowHeightInput {
  /** The rows' own height, without any body: a header and its gap. */
  collapsed: boolean;
  /** Lines the row's change adds and removes, or null when git did not count them. */
  changedLines: number | null;
  /** Whether the row is a file git reports as binary. */
  binary: boolean;
  /** Whether the row's path is a previewable image, so its body is a picture. */
  image: boolean;
}

/**
 * The first guess at a row's height. Once the row has been on screen its
 * real height is measured and that wins; this is only the first paint, and
 * it exists so a long list does not start out a few thousand pixels short.
 */
export function estimateRowHeight(input: RowHeightInput): number {
  if (input.collapsed) return ROW_HEADER_HEIGHT_PX;
  if (input.binary) return ROW_HEADER_HEIGHT_PX + (input.image ? IMAGE_BODY_HEIGHT_PX : NOTICE_BODY_HEIGHT_PX) + ROW_GAP_PX;
  if (input.changedLines === null || input.changedLines <= 0) {
    return ROW_HEADER_HEIGHT_PX + NOTICE_BODY_HEIGHT_PX + ROW_GAP_PX;
  }
  return ROW_HEADER_HEIGHT_PX + estimateDiffBodyHeight(input.changedLines) + ROW_GAP_PX;
}
