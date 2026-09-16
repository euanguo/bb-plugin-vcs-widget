// The diff renderer for the stream.
//
// bb's own experimental_Diff gives a plugin no selection affordances: the host
// component only turns on the gutter "+" and line selection when the host
// passes onSelectionAddToChat, and the plugin-facing wrapper never does. So the
// plugin renders @pierre/diffs/react itself. That is the same component from
// the same host-resident module, so the highlighter, the worker pool and bb's
// registered themes are shared rather than duplicated.
//
// Cost is why every value handed to FileDiff is memoized. Parsing a patch into
// FileDiffMetadata and rendering a FileDiff are both real work, and a stream
// holds one of these per file: the parse is keyed on the patch text alone, the
// options object and both callbacks keep their identity across renders, and
// the component is memoized so a sibling row's update cannot re-render it.
import { memo, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { processFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs/react";
import { experimental_useCodeTheme, useComposer } from "@get-bb/plugin-sdk/app";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@/components/ui/button";
import { quoteForRange, type DiffLineRange, type DiffLineSide } from "../shared/diff-quote";

/** How many unchanged lines an expansion shows. bb's own panel uses 30. */
const EXPANSION_LINE_COUNT = 30;

/** The line height the host's own diff uses, so both read the same. */
// React's CSSProperties has no index signature for custom properties, and
// these two are what the host's own diff sets on its frame.
const FRAME_STYLE = { "--diffs-font-size": "12px", "--diffs-line-height": "18px" } as unknown as CSSProperties;

/**
 * The gutter "+" has to style itself.
 *
 * The host's own diff gets this button for free: @pierre/diffs builds it inside
 * the shadow root, where its own `[data-utility-button]` rule paints a solid
 * blue square. A plugin's `renderGutterUtility` node is rendered as light DOM
 * and slotted in, so that rule cannot reach it and nothing but the button's own
 * classes apply. Left as a ghost button it is transparent, which reads as an
 * invisible control. These classes reproduce the host's shape: a solid primary
 * square, the icon in the foreground colour, 4px corners.
 */
const GUTTER_BUTTON_CLASS =
  "relative z-[4] h-[18px] w-[18px] shrink-0 rounded-[4px] bg-primary px-0 py-0 text-primary-foreground hover:bg-primary/90 [&_svg]:size-3";

export interface PluginDiffContents {
  old: { path: string; content: string };
  new: { path: string; content: string };
}

interface PluginDiffProps {
  patch: string;
  path: string;
  /** Both complete sides when the caller has them, for context expansion. */
  contents?: PluginDiffContents | null;
  /**
   * Whether a long line wraps or scrolls sideways. Scrolling is the default
   * because a wrapped diff is harder to read line by line, but a reader
   * looking at prose in a narrow pane wants the wrap.
   */
  wrap?: boolean;
  className?: string;
}

/** git needs the file header; a bare hunk is completed the way bb completes it. */
function withHeader(patch: string, path: string): string {
  const text = patch.replace(/\r\n/gu, "\n").trimEnd();
  if (text.length === 0) return "";
  if (text.startsWith("diff --git ")) return text + "\n";
  return "diff --git a/" + path + " b/" + path + "\n--- a/" + path + "\n+++ b/" + path + "\n" + text + "\n";
}

/** One run of lines has to match between the patch and the contents-derived diff. */
function sameRun(expected: readonly string[], expectedStart: number, actual: readonly string[], actualStart: number, count: number): boolean {
  if (expectedStart < 0 || actualStart < 0 || count < 0) return false;
  if (expectedStart + count > expected.length || actualStart + count > actual.length) return false;
  for (let index = 0; index < count; index += 1) {
    if (expected[expectedStart + index] !== actual[actualStart + index]) return false;
  }
  return true;
}

/**
 * Whether a diff derived from both complete sides describes the same hunks as
 * the patch. Only then may the renderer expand unchanged lines: a side that
 * disagrees would expand into the wrong text.
 */
function agreesWithPatch(fromPatch: FileDiffMetadata, fromContents: FileDiffMetadata): boolean {
  if (fromPatch.hunks.length !== fromContents.hunks.length) return false;
  return fromPatch.hunks.every((hunk, index) => {
    const other = fromContents.hunks[index];
    if (other === undefined) return false;
    return (
      sameRun(fromPatch.deletionLines, hunk.deletionLineIndex, fromContents.deletionLines, other.deletionLineIndex, hunk.deletionCount) &&
      sameRun(fromPatch.additionLines, hunk.additionLineIndex, fromContents.additionLines, other.additionLineIndex, hunk.additionCount)
    );
  });
}

/** Whether a selected range covers the line under the pointer. */
function coversLine(range: DiffLineRange, line: number, side: DiffLineSide): boolean {
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  if (line < from || line > to) return false;
  const rangeSide = range.side ?? range.endSide ?? null;
  return rangeSide === null || rangeSide === side;
}

function PluginDiffView({ patch, path, contents = null, wrap = false, className }: PluginDiffProps) {
  const composer = useComposer();
  const theme = experimental_useCodeTheme();
  // The range the reader last dragged, so the gutter button can quote all of
  // it rather than only the line under the pointer.
  const selectionRef = useRef<DiffLineRange | null>(null);

  // The parse is the expensive part, and it depends on the patch text alone.
  const metadata = useMemo(() => {
    const text = withHeader(patch, path);
    if (text.length === 0) return null;
    const fromPatch = processFile(text);
    if (fromPatch === undefined) return null;
    if (contents === null) return fromPatch;
    const fromContents = processFile(text, {
      oldFile: { name: contents.old.path, contents: contents.old.content },
      newFile: { name: contents.new.path, contents: contents.new.content },
    });
    if (fromContents === undefined || fromContents.isPartial) return fromPatch;
    return agreesWithPatch(fromPatch, fromContents) ? fromContents : fromPatch;
  }, [patch, path, contents]);

  // Depending on the whole composer object would rebuild the callbacks
  // whenever any unrelated part of it changed, and the renderer compares them.
  const addQuote = composer.addQuote;
  const quote = useCallback(
    (lineRange: DiffLineRange) => {
      const text = quoteForRange(patch, path, lineRange);
      if (text === null) return;
      addQuote(text);
    },
    [addQuote, patch, path],
  );

  const gutter = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: DiffLineSide } | undefined) => (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={GUTTER_BUTTON_CLASS}
        aria-label="Add this line to chat"
        data-testid={"vcs-diff-gutter-" + path}
        onClick={() => {
          const line = getHoveredLine();
          if (line === undefined) return;
          const selected = selectionRef.current;
          if (selected !== null && coversLine(selected, line.lineNumber, line.side)) quote(selected);
          else quote({ start: line.lineNumber, end: line.lineNumber, side: line.side });
        }}
      >
        <Icon name="Plus" className="size-3" />
      </Button>
    ),
    [path, quote],
  );

  const expandable = metadata !== null && !metadata.isPartial;

  // A fresh object here would make the renderer redo its work, so this is
  // rebuilt only when the theme or the expansion changes.
  const options = useMemo(
    () => ({
      theme: theme.name,
      themeType: theme.mode,
      diffStyle: "unified" as const,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      lineHoverHighlight: "number" as const,
      enableGutterUtility: true,
      enableLineSelection: true,
      ...(expandable ? { expansionLineCount: EXPANSION_LINE_COUNT } : {}),
      onLineSelectionStart: () => {
        selectionRef.current = null;
      },
      onLineSelectionEnd: (lineRange: SelectedLineRange | null) => {
        selectionRef.current =
          lineRange === null
            ? null
            : { start: lineRange.start, end: lineRange.end, side: lineRange.side ?? null, endSide: lineRange.endSide ?? null };
      },
    }),
    [theme.name, theme.mode, expandable, wrap],
  );

  if (metadata === null) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">No textual difference on this side.</p>;
  }

  return (
    <div className={className} style={FRAME_STYLE}>
      <FileDiff fileDiff={metadata} options={options} renderGutterUtility={gutter} />
    </div>
  );
}

export const PluginDiff = memo(PluginDiffView);
