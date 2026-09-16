// How tall a diff body is, for the placeholder that stands in for a card the
// stream has scrolled away from.
//
// The stream keeps every row's shell in the DOM but mounts the diff renderer
// only near the viewport, because a mounted card is a shadow-DOM tree holding
// every changed line of that file. The placeholder replacing it has to occupy
// the same space, or the scrollbar would lie and the reader's position would
// jump when the card comes back.
//
// Nothing here is exact. Once a card has been on screen its real height is
// measured (the ResizeObserver in ContinuousDiffStream) and that wins; this is
// only the first guess for a card that has never been measured, so that a long
// list does not start out a few thousand pixels too short.

/** The line height the renderer is configured with, in the plugin's frame style. */
export const DIFF_LINE_HEIGHT_PX = 18;

/** Padding the renderer adds around the lines. */
export const DIFF_BODY_PADDING_PX = 8;

/** A one-line notice: the `px-3 py-3` padding around a `text-xs` line. */
export const NOTICE_BODY_HEIGHT_PX = 36;

/** An image preview, whose own component sets a taller frame. */
export const IMAGE_BODY_HEIGHT_PX = 160;

/** The height of a diff of `lineCount` rendered lines. */
export function estimateDiffBodyHeight(lineCount: number): number {
  return Math.max(1, Math.trunc(lineCount)) * DIFF_LINE_HEIGHT_PX + DIFF_BODY_PADDING_PX;
}
