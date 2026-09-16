// The continuous stream: every changed file's diff stacked in one scrollable
// column, with the file list beside it. A file's patch is read when it comes
// into view (see use-diff-patches), so opening a sixty-file worktree reads
// the few the reader is actually looking at.
//
// A row is one file on one side: a header that stays put while its body
// scrolls past, and a body that is either a diff, a notice (binary, too large,
// not yet read) or nothing at all while collapsed. Both sides live in the one
// stream: a file that is staged and edited again shows its staged change and
// its unstaged change as consecutive rows, so nothing needs a mode switch to
// be seen. Staged comes first, which is the order git status reports.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEntry } from "../contracts";
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import type { DiffChannel } from "../shared/target";
import { DIFF_FILES_INLINE_PATCH_MAX_FILES } from "../shared/diff-tiering";
import type { DiffPatchState, UseDiffPatchesResult } from "../hooks/use-diff-patches";
import type { DiffContentsState, UseDiffContentsResult } from "../hooks/use-diff-contents";
import { previewableImageMime } from "../shared/constants";
import { patchRows } from "../shared/diff-quote";
import {
  estimateDiffBodyHeight,
  IMAGE_BODY_HEIGHT_PX,
  NOTICE_BODY_HEIGHT_PX,
} from "../shared/diff-height";
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
 * so the stream mounts the cards near the reader and replaces the rest with a
 * spacer of the height they measured last time they were on screen.
 *
 * The margin is deliberately generous. Unmounting and remounting a card costs
 * a re-parse, and the host's highlighter cache only makes that cheap, not free,
 * so a card the reader scrolls back over should still be there.
 */
const MOUNT_ROOT_MARGIN = "800px 0px";

/** A row is one file on one channel; the same path can hold two rows. */
export function streamRowKey(item: DiffStreamEntry): string {
  return `${item.entry.path}:${item.channel}`;
}

/** The same key, read back off a row element by the observers. */
function elementKey(element: HTMLElement): string | null {
  const path = element.dataset.path;
  const channel = element.dataset.channel;
  if (path === undefined || channel === undefined) return null;
  return `${path}:${channel}`;
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
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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
  const registerRef = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element === null) rowRefs.current.delete(key);
    else rowRefs.current.set(key, element);
  }, []);
  // The rows whose diff renderer is mounted. `null` means "mount everything",
  // which is what an environment without IntersectionObserver gets: better a
  // heavy stream than an empty one.
  const [mounted, setMounted] = useState<ReadonlySet<string> | null>(null);

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
  useEffect(() => {
    for (const channel of channels) patches[channel]?.prunePaths(paths);
  }, [paths, channels, patches]);
  useEffect(() => {
    for (const channel of channels) patches[channel]?.invalidate();
  }, [filesUpdatedAt, channels, patches]);
  // The full-text cache follows the same lifecycle as the patch cache.
  useEffect(() => {
    for (const channel of channels) contents[channel]?.prune(paths);
  }, [paths, channels, contents]);
  useEffect(() => {
    for (const channel of channels) contents[channel]?.invalidate();
  }, [filesUpdatedAt, channels, contents]);

  // Only what is on screen (plus a little either side) is asked for. Where
  // the environment has no IntersectionObserver (jsdom, an old webview) the
  // first page is read instead, so the stream still shows diffs rather than
  // nothing at all.
  useEffect(() => {
    if (!isPanelOpen) return;
    const container = scrollRef.current;
    if (container === null) return;
    const ask = (visible: Record<string, string[]>, overscan: Record<string, string[]>) => {
      const withRenames = (list: readonly string[]) => [...new Set(list.flatMap((path) => (oldPathByPath.has(path) ? [path, oldPathByPath.get(path)!] : [path])))];
      for (const channel of channels) {
        patches[channel]?.requestPaths({ visible: withRenames(visible[channel] ?? []), overscan: withRenames(overscan[channel] ?? []) });
      }
    };
    if (typeof IntersectionObserver === "undefined") {
      const first = entries.slice(0, DIFF_FILES_INLINE_PATCH_MAX_FILES);
      const visible: Record<string, string[]> = {};
      for (const channel of channels) visible[channel] = first.filter((item) => item.channel === channel).map((item) => item.entry.path);
      ask(visible, {});
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        const visible: Record<string, string[]> = {};
        const overscan: Record<string, string[]> = {};
        for (const record of observed) {
          const element = record.target as HTMLElement;
          const path = element.dataset.path;
          const channel = element.dataset.channel;
          if (path === undefined || channel === undefined) continue;
          const bucket = record.isIntersecting ? visible : overscan;
          (bucket[channel] ??= []).push(path);
        }
        // Anything already loaded stays loaded; the hook filters.
        ask(visible, overscan);
      },
      { root: container, rootMargin: "200px 0px" },
    );
    for (const element of rowRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [entries, channels, isPanelOpen, patches]);

  // The mount window. Separate from the reader above because it answers a
  // different question — "is this card close enough to keep rendered?" — with a
  // much wider margin than "is this file worth reading yet?".
  useEffect(() => {
    if (!isPanelOpen) return;
    const container = scrollRef.current;
    if (container === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setMounted(null);
      return;
    }
    const keys = new Set(entries.map(streamRowKey));
    const observer = new IntersectionObserver(
      (observed) => {
        setMounted((previous) => {
          // A file that left the list takes its row with it.
          const next = new Set<string>();
          for (const key of previous ?? []) if (keys.has(key)) next.add(key);
          for (const record of observed) {
            const key = elementKey(record.target as HTMLElement);
            if (key === null) continue;
            if (record.isIntersecting) next.add(key);
            else next.delete(key);
          }
          return next;
        });
      },
      { root: container, rootMargin: MOUNT_ROOT_MARGIN },
    );
    for (const element of rowRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [entries, isPanelOpen]);

  useEffect(() => {
    if (scrollToPath === null) return;
    // A file with two rows scrolls to its first one.
    const first = entries.find((item) => item.entry.path === scrollToPath);
    if (first === undefined) return;
    const element = rowRefs.current.get(streamRowKey(first));
    if (element === undefined) return;
    element.scrollIntoView({ block: "start" });
    onScrolledToPath();
  }, [scrollToPath, entries, onScrolledToPath]);

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
        <div className="flex min-w-0 flex-col">
          {entries.map((item) => {
            const key = streamRowKey(item);
            return (
              <DiffStreamRowItem
                key={key}
                threadId={threadId}
                item={item}
                patchState={patches[item.channel].getPatchState(item.entry.path)}
                contentsState={contents[item.channel].getContents(item.entry.path)}
                isCollapsed={collapsed.has(key)}
                isMounted={mounted === null || mounted.has(key)}
                wrap={wrap}
                onOpenFile={onOpenFile}
                onToggleCollapsed={onToggleCollapsed}
                registerRef={registerRef}
                requestContents={requestContents}
                loadPatch={loadPatch}
                retryPatch={retryPatch}
              />
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
  /** Whether this row's diff renderer is close enough to the viewport to mount. */
  isMounted: boolean;
  onToggleCollapsed: () => void;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
  /** Whether a long line wraps instead of scrolling sideways. */
  wrap: boolean;
  registerRef: (element: HTMLDivElement | null) => void;
}

/** The first guess at a row's body height, for a card never yet measured. */
function estimateBodyHeight(entry: ChangeEntry, patchState: DiffPatchState): number {
  if (patchState.status === "loaded" && patchState.binary === true) {
    const mimeType = previewableImageMime(entry.path) ?? previewableImageMime(entry.oldPath);
    return mimeType === null ? NOTICE_BODY_HEIGHT_PX : IMAGE_BODY_HEIGHT_PX;
  }
  if (patchState.status === "loaded" && patchState.patch !== undefined && patchState.patch.trim() !== "") {
    const rows = patchRows(patchState.patch).length;
    if (rows > 0) return estimateDiffBodyHeight(rows);
  }
  return NOTICE_BODY_HEIGHT_PX;
}

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


/**
 * One row, wired to the readers.
 *
 * It exists so the row can be memoized: every handle it is given has to keep
 * its identity across renders, and the per-row ones are built here from the
 * row's own channel and path. Without this, one patch landing replaced the
 * closure of every other row and re-rendered the whole column.
 */
interface DiffStreamRowItemProps {
  threadId: string;
  item: DiffStreamEntry;
  patchState: DiffPatchState;
  contentsState: DiffContentsState;
  isCollapsed: boolean;
  isMounted: boolean;
  wrap: boolean;
  onOpenFile?: (path: string) => void;
  onToggleCollapsed: (key: string) => void;
  registerRef: (key: string, element: HTMLDivElement | null) => void;
  requestContents: (channel: DiffChannel, path: string, oldPath: string | null) => void;
  loadPatch: (channel: DiffChannel, path: string) => void;
  retryPatch: (channel: DiffChannel, path: string) => void;
}

const DiffStreamRowItem = memo(function DiffStreamRowItem({
  threadId,
  item,
  patchState,
  contentsState,
  isCollapsed,
  isMounted,
  wrap,
  onOpenFile,
  onToggleCollapsed,
  registerRef,
  requestContents,
  loadPatch,
  retryPatch,
}: DiffStreamRowItemProps) {
  const { entry, channel, tag } = item;
  const key = streamRowKey(item);
  const handleToggleCollapsed = useCallback(() => onToggleCollapsed(key), [onToggleCollapsed, key]);
  const handleRequestContents = useCallback(
    () => requestContents(channel, entry.path, entry.oldPath),
    [requestContents, channel, entry.path, entry.oldPath],
  );
  const handleLoadPatch = useCallback(() => loadPatch(channel, entry.path), [loadPatch, channel, entry.path]);
  const handleRetry = useCallback(() => retryPatch(channel, entry.path), [retryPatch, channel, entry.path]);
  const handleRef = useCallback(
    (element: HTMLDivElement | null) => registerRef(key, element),
    [registerRef, key],
  );
  return (
    <DiffStreamRow
      threadId={threadId}
      entry={entry}
      channel={channel}
      tag={tag}
      patchState={patchState}
      contentsState={contentsState}
      onRequestContents={handleRequestContents}
      isCollapsed={isCollapsed}
      isMounted={isMounted}
      onToggleCollapsed={handleToggleCollapsed}
      onLoadPatch={handleLoadPatch}
      onRetry={handleRetry}
      onOpenFile={onOpenFile}
      wrap={wrap}
      registerRef={handleRef}
    />
  );
});

function DiffStreamRow({
  threadId,
  entry,
  channel,
  tag,
  patchState,
  contentsState,
  onRequestContents,
  isCollapsed,
  isMounted,
  onToggleCollapsed,
  onLoadPatch,
  onRetry,
  onOpenFile,
  wrap,
  registerRef,
}: DiffStreamRowProps) {
  const label = entry.oldPath === null || entry.oldPath === entry.path ? entry.path : `${entry.oldPath} -> ${entry.path}`;
  const letter = statusLetter(entry);

  // The height this row's body measured the last time it was mounted, so the
  // spacer that replaces it holds the same space. `estimatedBodyHeight` is only
  // the first guess, for a card that has never been on screen.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightRef = useRef<number | null>(null);
  const estimatedBodyHeight = useMemo(() => estimateBodyHeight(entry, patchState), [entry, patchState]);

  // Measure only while the body is mounted. The observer is torn down when the
  // row leaves the window, so the spacer cannot overwrite the number that
  // decided how tall the spacer should be.
  useEffect(() => {
    const element = bodyRef.current;
    if (!isMounted || isCollapsed || element === null) return;
    if (typeof ResizeObserver === "undefined") {
      measuredHeightRef.current = element.getBoundingClientRect().height;
      return;
    }
    const observer = new ResizeObserver((observed) => {
      for (const record of observed) measuredHeightRef.current = record.contentRect.height;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isMounted, isCollapsed]);

  return (
    <section
      ref={registerRef}
      data-path={entry.path}
      data-channel={channel}
      data-testid={`vcs-stream-row-${entry.path}-${channel}`}
      className="min-w-0 border-b border-border/60 last:border-b-0"
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
        <div ref={bodyRef}>
          {isMounted ? (
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
          ) : (
            <div
              style={{ height: measuredHeightRef.current ?? estimatedBodyHeight }}
              data-testid={`vcs-stream-spacer-${entry.path}-${channel}`}
            />
          )}
        </div>
      )}
    </section>
  );
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
