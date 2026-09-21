// The continuous stream: every changed file's diff stacked in one scrollable
// column, with the file list beside it. A file's patch is read when it comes
// into view (see use-diff-patches), so opening a sixty-file worktree reads
// the few the reader is actually looking at.
//
// A row is one file on one side: a header that stays put while its body
// scrolls past, and a body that is either a diff, a notice (binary, too large,
// not yet read) or nothing at all while collapsed. Both sides live in the
// one stream: a file that is staged and edited again shows its staged change and
// its unstaged change as consecutive rows, so nothing needs a mode switch to
// be seen. Staged comes first, which is the order git status reports.
//
// The rows are windowed by @tanstack/react-virtual, the same library the bb
// host itself uses for its diff panel. It measures each row's real height as it
// is rendered and keeps the arithmetic honest, which is what a stream of
// variable-height diff cards needs: the previous hand-rolled scheme kept every
// row's shell in the DOM and swapped the expensive diff renderer for a spacer
// of the height it had last measured, which put an observer per row on the
// main thread and made the scrollbar lie until every row had been on screen.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEntry } from "../contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import type { DiffChannel } from "../shared/target";
import { DIFF_FILES_INLINE_PATCH_MAX_FILES } from "../shared/diff-tiering";
import { previewableImageMime } from "../shared/constants";
import { estimateRowHeight } from "../shared/row-height";
import type { DiffPatchState, UseDiffPatchesResult } from "../hooks/use-diff-patches";
import type { DiffContentsState, UseDiffContentsResult } from "../hooks/use-diff-contents";
import { ImageDiffPreview } from "./ImageDiffPreview";
import { PluginDiff } from "./PluginDiff";
import { statusLetterClass } from "./status-letter";

/** One file on one channel: a side of the index, or a commit target. */
export interface DiffStreamEntry {
  entry: ChangeEntry;
  channel: DiffChannel;
  /** The tag the row wears — "Staged", "Unstaged" — or null for a target. */
  tag: string | null;
}

/** One row, placed: what to render and where it sits in the column. */
interface PlacedRow {
  entry: DiffStreamEntry;
  /** The row's index in the stream, which is also its identity to the library. */
  index: number;
  /** The row's top edge, in the column's coordinates. */
  top: number;
  /** The row's height, so the column is as tall as the sum of its rows. */
  height: number;
}

/**
 * Rows painted before the scroll container has been measured.
 *
 * The library answers "what is near the reader" from the container's height,
 * and a container nobody has measured is zero pixels tall, so its window is
 * empty. That is right for a list that has not been laid out yet, and wrong
 * for a stream that must show something on its first paint: jsdom measures
 * nothing at all, and a real panel is briefly zero-tall before its first
 * layout. So while the container is unmeasured the stream paints a first
 * batch of rows instead of an empty column.
 */
const UNMEASURED_ROWS = 12;

interface ContinuousDiffStreamProps {
  threadId: string;
  entries: readonly DiffStreamEntry[];
  /** One reader per channel; the two index sides need one each. */
  patches: Readonly<Record<string, UseDiffPatchesResult>>;
  /** Complete old/new text per path, for "expand unchanged lines". */
  contents: Readonly<Record<string, UseDiffContentsResult>>;
  /** Whether a long line wraps instead of scrolling sideways. */
  wrap: boolean;
  /** Bumped whenever `changes` arrives, so stale patches are re-read. */
  filesUpdatedAt: unknown;
  isPanelOpen: boolean;
  /** Scroll here when the file list selects a path. */
  scrollToPath: string | null;
  onScrolledToPath: () => void;
  /** Rows the reader has folded, by `streamRowKey`. */
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (key: string) => void;
  onOpenFile?: (path: string) => void;
  className?: string;
}

/**
 * How far past the viewport a card is still mounted. A mounted card is the
 * expensive one — the renderer builds a shadow-DOM tree of every changed line —
 * so the stream mounts the cards near the reader and leaves the rest out of the
 * DOM entirely.
 *
 * This is expressed in rows rather than pixels, because the virtualizer's
 * window is in rows: two rows either side of a screenful is a read-ahead a
 * fast flick cannot outrun, and it bounds how many cards are ever mounted by
 * the viewport rather than by the size of the change set.
 */
const MOUNT_OVERSCAN_ROWS = 2;

/** A row is one file on one channel; the same path can hold two rows. */
export function streamRowKey(item: DiffStreamEntry): string {
  return `${item.entry.path}:${item.channel}`;
}

export function ContinuousDiffStream({
  threadId,
  entries,
  patches,
  contents,
  wrap,
  filesUpdatedAt,
  isPanelOpen,
  scrollToPath,
  onScrolledToPath,
  collapsed,
  onToggleCollapsed,
  onOpenFile,
  className,
}: ContinuousDiffStreamProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The readers a row reaches through. Kept behind refs so the handles handed
  // to a row keep their identity: a fresh closure per render would defeat the
  // row's memo, and then one patch landing would re-render all of them.
  const latestReaders = useRef({ patches, contents });
  latestReaders.current = { patches, contents };
  const requestContents = useCallback(
    (channel: DiffChannel, path: string, oldPath: string | null) => latestReaders.current.contents[channel].requestContents(path, oldPath),
    [],
  );
  const loadPatch = useCallback(
    (channel: DiffChannel, path: string) => latestReaders.current.patches[channel].loadPath(path),
    [],
  );
  const retryPatch = useCallback(
    (channel: DiffChannel, path: string) => latestReaders.current.patches[channel].retry(path),
    [],
  );

  // The distinct files, for the prune calls and the summary line.
  //
  // A rename counts as both of its paths: git only reports one when the
  // pathspec holds both sides of it, so a row that asks for its new path alone
  // is handed the file as an addition instead of a rename.
  const paths = useMemo(
    () => [...new Set(entries.flatMap((item) => (item.entry.oldPath === null ? [item.entry.path] : [item.entry.path, item.entry.oldPath])))],
    [entries],
  );

  // The readers this stream actually has rows for. Derived from the rows
  // rather than fixed at the two index sides, because a commit target has one
  // channel and no second side to read.
  const channels = useMemo(() => [...new Set(entries.map((item) => item.channel))], [entries]);

  /** The original path of each renamed file, keyed by the path it lives at now. */
  const oldPathByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of entries) {
      const { path, oldPath } = item.entry;
      if (oldPath !== null && oldPath !== path) map.set(path, oldPath);
    }
    return map;
  }, [entries]);

  // Forget patches for files that left the list, and re-read the ones that are
  // still here after the working tree changed. Both sides move together: the
  // reader that has nothing to fetch does nothing.
  //
  // These call through the reader refs rather than listing `patches` and
  // `contents` as dependencies. Those objects are rebuilt whenever any single
  // patch lands, so depending on them re-ran this whole group — and rebuilt the
  // observer below, re-observing every row — once per file that finished
  // loading.
  useEffect(() => {
    for (const channel of channels) latestReaders.current.patches[channel]?.prunePaths(paths);
  }, [paths, channels]);
  useEffect(() => {
    for (const channel of channels) latestReaders.current.patches[channel]?.invalidate();
  }, [filesUpdatedAt, channels]);
  // The full-text cache follows the same lifecycle as the patch cache.
  useEffect(() => {
    for (const channel of channels) latestReaders.current.contents[channel]?.prune(paths);
  }, [paths, channels]);
  useEffect(() => {
    for (const channel of channels) latestReaders.current.contents[channel]?.invalidate();
  }, [filesUpdatedAt, channels]);

  // The window itself. The estimate per row is the change size git reported,
  // which is what the row already knows before its diff has been read; the
  // library replaces it with the measured height as each row is rendered.
  //
  // `getItemKey` keeps a row's identity its `path:channel`, so a re-order of
  // the list moves the row rather than rebuilding it.
  //
  // Each row's first guess at its height, from what the row already knows
  // before its diff has been read. The library replaces it with the row's
  // measured height as the row is rendered, so this only places the rows the
  // library has not measured yet.
  const estimateRowHeightAt = useCallback(
    (index: number) => {
      const item = entries[index];
      if (item === undefined) return 0;
      const { entry } = item;
      const patchState = patches[item.channel].getPatchState(entry.path);
      return estimateRowHeight({
        collapsed: collapsed.has(streamRowKey(item)),
        changedLines: entry.additions !== null && entry.deletions !== null ? entry.additions + entry.deletions : null,
        binary: entry.kind !== "tracked" || patchState.binary === true,
        image: previewableImageMime(entry.path) !== null || previewableImageMime(entry.oldPath) !== null,
      });
    },
    [entries, patches, collapsed],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateRowHeightAt,
    getItemKey: (index) => streamRowKey(entries[index]!),
    overscan: MOUNT_OVERSCAN_ROWS,
    enabled: isPanelOpen,
  });
  /** The window the library has settled on: what is near the reader. */
  const items = virtualizer.getVirtualItems();

  /**
   * The rows to paint, each with the top edge it has been placed at.
   *
   * While the scroll container is unmeasured the library's window is empty,
   * and these are the first rows instead, laid out from their estimates. Once
   * the container is measured the library's own window is the answer and it
   * carries the measured heights, so this is only the standing start.
   */
  const placed = useMemo<readonly PlacedRow[]>(() => {
    if (items.length > 0) {
      return items.map((item) => ({
        entry: entries[item.index]!,
        index: item.index,
        top: item.start,
        height: item.size,
      }));
    }
    const first: PlacedRow[] = [];
    let top = 0;
    for (let index = 0; index < Math.min(entries.length, UNMEASURED_ROWS); index += 1) {
      const height = estimateRowHeightAt(index);
      first.push({ entry: entries[index]!, index, top, height });
      top += height;
    }
    return first;
  }, [items, entries, estimateRowHeightAt]);

  const last = placed.length === 0 ? null : placed[placed.length - 1]!;
  /** How tall the column is: the sum of every row, measured or estimated. */
  const columnHeight = virtualizer.getTotalSize() > 0 ? virtualizer.getTotalSize() : last === null ? 0 : last.top + last.height;

  // Only what is on screen, plus the margin the virtualizer is given, is asked
  // for. The margin is the read-ahead: it used to be a separate list of every
  // row that was *not* on screen, which was bounded by the size of the change
  // set rather than by the viewport, so opening a four-hundred-file worktree
  // could ask the host for all four hundred at once.
  //
  // Where the environment has no IntersectionObserver (jsdom, an old webview)
  // the first page is read instead, so the stream still shows diffs rather
  // than nothing at all.
  useEffect(() => {
    if (!isPanelOpen) return;
    /** A rename is read by both of its paths; git reports neither alone. */
    const withRenames = (list: readonly string[]) =>
      [...new Set(list.flatMap((path) => (oldPathByPath.has(path) ? [path, oldPathByPath.get(path)!] : [path])))];
    const ask = (byChannel: Record<string, string[]>) => {
      const readers = latestReaders.current.patches;
      for (const channel of channels) readers[channel]?.requestPaths(withRenames(byChannel[channel] ?? []));
    };
    if (typeof IntersectionObserver === "undefined") {
      const first: Record<string, string[]> = {};
      for (const channel of channels) {
        first[channel] = entries
          .filter((item) => item.channel === channel)
          .slice(0, DIFF_FILES_INLINE_PATCH_MAX_FILES)
          .map((item) => item.entry.path);
      }
      ask(first);
      return;
    }
    // The rows the window has mounted, which is exactly the set the observer
    // would have reported. Reading the virtualizer here rather than re-
    // observing every row is what removes the per-row observer: the window is
    // already the answer to "what is near the reader".
    // The rows actually painted, which while the container is unmeasured are
    // the first batch rather than the library's window.
    const visible: Record<string, string[]> = {};
    for (const item of placed) {
      (visible[item.entry.channel] ??= []).push(item.entry.entry.path);
    }
    ask(visible);
  }, [placed, entries, channels, isPanelOpen, oldPathByPath]);

  // A file-list click scrolls the stream to that file's first row. Done
  // through the virtualizer rather than `scrollIntoView`, which would scroll
  // the row's own container and, with a windowed stream, the row that is
  // asked for is the one that has just been rendered for it.
  useEffect(() => {
    if (scrollToPath === null) return;
    const index = entries.findIndex((item) => item.entry.path === scrollToPath);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "start" });
    onScrolledToPath();
  }, [scrollToPath, entries, virtualizer, onScrolledToPath]);

  if (entries.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}>
        <p className="text-sm text-muted-foreground">Nothing to commit: the working tree is clean.</p>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-testid="vcs-stream">
        {/* The one box that holds the window's rows, sized to the sum of every
            row's measured or estimated height so the scrollbar is honest. */}
        <div className="relative w-full" style={{ height: columnHeight }} data-testid="vcs-stream-column">
          {placed.map((item) => {
            const row = item.entry;
            const key = streamRowKey(row);
            return (
              <div
                key={key}
                ref={virtualizer.measureElement}
                className="absolute left-0 w-full"
                style={{ top: item.top }}
                data-index={item.index}
                data-path={row.entry.path}
                data-channel={row.channel}
              >
                <DiffStreamRow
                  threadId={threadId}
                  entry={row.entry}
                  channel={row.channel}
                  tag={row.tag}
                  patchState={patches[row.channel].getPatchState(row.entry.path)}
                  contentsState={contents[row.channel].getContents(row.entry.path)}
                  isCollapsed={collapsed.has(key)}
                  wrap={wrap}
                  onOpenFile={onOpenFile}
                  onToggleCollapsed={() => onToggleCollapsed(key)}
                  onRequestContents={() => requestContents(row.channel, row.entry.path, row.entry.oldPath)}
                  onLoadPatch={() => loadPatch(row.channel, row.entry.path)}
                  onRetry={() => retryPatch(row.channel, row.entry.path)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DiffStreamRowProps {
  threadId: string;
  entry: ChangeEntry;
  /** Which reader answers for this row. */
  channel: DiffChannel;
  /** The tag the row wears, or null when the target already says what it is. */
  tag: string | null;
  patchState: DiffPatchState;
  contentsState: DiffContentsState;
  onRequestContents: () => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
  /** Whether a long line wraps instead of scrolling sideways. */
  wrap: boolean;
}

/**
 * One row, wired to the readers.
 *
 * It exists so the row can be memoized: every handle it is given has to keep
 * its identity across renders, and the per-row ones are built here from the
 * row's own channel and path. Without this, one patch landing replaced the
 * closure of every other row and re-rendered the whole column.
 */
const DiffStreamRow = memo(function DiffStreamRow({
  threadId,
  entry,
  channel,
  tag,
  patchState,
  contentsState,
  onRequestContents,
  isCollapsed,
  onToggleCollapsed,
  onLoadPatch,
  onRetry,
  onOpenFile,
  wrap,
}: DiffStreamRowProps) {
  const label = entry.oldPath === null || entry.oldPath === entry.path ? entry.path : `${entry.oldPath} -> ${entry.path}`;
  const letter = statusLetter(entry);
  return (
    <section
      className="min-w-0 border-b border-border/60"
      data-channel={channel}
      data-testid={`vcs-stream-row-${entry.path}-${channel}`}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          aria-label={isCollapsed ? `Expand ${label}` : `Collapse ${label}`}
          aria-expanded={!isCollapsed}
          onClick={onToggleCollapsed}
        >
          <Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
        </Button>
        <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", statusLetterClass(letter))} aria-label={`status ${letter}`}>
          {letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={label}>
          {label}
        </span>
        {tag === null ? null : (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid={`vcs-stream-side-tag-${entry.path}-${channel}`}>
            {tag}
          </span>
        )}
        {patchState.status === "loaded" && patchState.truncated ? (
          <span className="shrink-0 text-xs text-muted-foreground">truncated</span>
        ) : null}
        {onOpenFile !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => onOpenFile(entry.path)}
          >
            Open
          </Button>
        ) : null}
      </header>
      {isCollapsed ? null : (
        <DiffStreamBody
          threadId={threadId}
          entry={entry}
          channel={channel}
          patchState={patchState}
          contentsState={contentsState}
          onRequestContents={onRequestContents}
          onLoadPatch={onLoadPatch}
          onRetry={onRetry}
          onOpenFile={onOpenFile}
          wrap={wrap}
        />
      )}
    </section>
  );
});

const STATUS_LETTER: Record<string, string> = {
  M: "M",
  T: "T",
  R: "R",
  A: "A",
  C: "C",
  D: "D",
  "?": "?",
  U: "U",
};

function statusLetter(entry: ChangeEntry): string {
  if (entry.kind === "untracked") return "?";
  if (entry.kind === "conflicted") return "U";
  return STATUS_LETTER[entry.worktree !== "." ? entry.worktree : entry.index] ?? "M";
}

const NOTICE_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground";

function DiffStreamBody({
  threadId,
  entry,
  channel,
  patchState,
  contentsState,
  onRequestContents,
  onLoadPatch,
  onRetry,
  onOpenFile,
  wrap,
}: {
  threadId: string;
  entry: ChangeEntry;
  channel: DiffChannel;
  patchState: DiffPatchState;
  contentsState: DiffContentsState;
  onRequestContents: () => void;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
  wrap: boolean;
}) {
  // A patch with hunks can offer "expand unchanged lines" only once the
  // renderer also has both complete sides; ask for them as soon as the card
  // can use them (bb's own panel does the same, on idle). A binary card has
  // already returned below, so only truncation still rules the request out.
  const canExpandContext = patchState.status === "loaded" && patchState.truncated !== true;
  useEffect(() => {
    if (!canExpandContext) return;
    if (contentsState.status !== "idle") return;
    onRequestContents();
  }, [canExpandContext, contentsState.status, onRequestContents]);

  if (patchState.status === "error") {
    return (
      <div className={NOTICE_CLASS}>
        <span className="text-destructive">{patchState.error ?? "Failed to load this file's diff."}</span>
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs underline underline-offset-4" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (patchState.status === "idle" || patchState.status === "loading") {
    return (
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-loading-${entry.path}-${channel}`}>
        <span>{patchState.status === "loading" ? "Reading diff…" : "Not loaded yet."}</span>
        {patchState.status === "idle" ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs underline underline-offset-4" onClick={onLoadPatch}>
            Load diff
          </Button>
        ) : null}
      </div>
    );
  }

  if (patchState.binary === true) {
    // A previewable image gets a picture; anything else (a zip, a font, a
    // PDF) keeps the plain notice, because there is nothing to render.
    const mimeType = previewableImageMime(entry.path) ?? previewableImageMime(entry.oldPath);
    // An image preview reads both revisions of one side of the index; a
    // commit target has no such read yet, so those files keep the notice.
    if (mimeType !== null && channel !== "target") {
      return (
        <ImageDiffPreview
          threadId={threadId}
          path={entry.path}
          oldPath={entry.oldPath}
          side={channel}
          mimeType={mimeType}
        />
      );
    }
    return (
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-binary-${entry.path}-${channel}`}>
        <span>Binary file.</span>
        {onOpenFile !== undefined ? (
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs underline underline-offset-4" onClick={() => onOpenFile(entry.path)}>
            Open file
          </Button>
        ) : null}
      </div>
    );
  }

  if (patchState.patch === undefined || patchState.patch.trim() === "") {
    return (
      <div className={NOTICE_CLASS}>
        <span>No textual difference on this side.</span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", wrap ? "" : "overflow-x-auto")} data-testid={`vcs-stream-patch-${entry.path}-${channel}`} data-channel={channel}>
      <PluginDiff
        patch={patchState.patch}
        path={entry.path}
        contents={contentsState.status === "ready" ? contentsState.contents : null}
        wrap={wrap}
      />
    </div>
  );
}
