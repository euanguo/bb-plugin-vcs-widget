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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEntry } from "../contracts";
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import type { DiffSide } from "../shared/constants";
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

/** One file on one side of the index. */
export interface DiffStreamEntry {
  entry: ChangeEntry;
  side: DiffSide;
}

interface ContinuousDiffStreamProps {
  threadId: string;
  entries: readonly DiffStreamEntry[];
  /** One reader per side, because a batch read names exactly one side. */
  patches: Readonly<Record<DiffSide, UseDiffPatchesResult>>;
  /** Complete old/new text per path, for "expand unchanged lines". */
  contents: Readonly<Record<DiffSide, UseDiffContentsResult>>;
  /** Bumped whenever `changes` arrives, so stale patches are re-read. */
  filesUpdatedAt: unknown;
  isPanelOpen: boolean;
  /** Scroll here when the file list selects a path. */
  scrollToPath: string | null;
  onScrolledToPath: () => void;
  onOpenFile?: (path: string) => void;
  className?: string;
}

const SIDES: readonly DiffSide[] = ["index", "worktree"];

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

/** A row is one file on one side; the same path can hold two rows. */
function rowKey(item: DiffStreamEntry): string {
  return `${item.entry.path}:${item.side}`;
}

/** The same key, read back off a row element by the observers. */
function elementKey(element: HTMLElement): string | null {
  const path = element.dataset.path;
  const side = element.dataset.side;
  if (path === undefined || (side !== "index" && side !== "worktree")) return null;
  return `${path}:${side}`;
}

const SIDE_LABEL: Record<DiffSide, string> = {
  index: "Staged",
  worktree: "Unstaged",
};

export function ContinuousDiffStream({
  threadId,
  entries,
  patches,
  contents,
  filesUpdatedAt,
  isPanelOpen,
  scrollToPath,
  onScrolledToPath,
  onOpenFile,
  className,
}: ContinuousDiffStreamProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [collapsed, setCollapsed] = useState<Map<string, boolean>>(new Map());
  // The rows whose diff renderer is mounted. `null` means "mount everything",
  // which is what an environment without IntersectionObserver gets: better a
  // heavy stream than an empty one.
  const [mounted, setMounted] = useState<ReadonlySet<string> | null>(null);

  const isCollapsed = useCallback((key: string) => collapsed.get(key) ?? false, [collapsed]);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Map(previous);
      next.set(key, !(previous.get(key) ?? false));
      return next;
    });
  }, []);

  const allCollapsed = entries.length > 0 && entries.every((item) => isCollapsed(rowKey(item)));
  const toggleAll = useCallback(() => {
    const target = !allCollapsed;
    setCollapsed(new Map(entries.map((item) => [rowKey(item), target])));
  }, [allCollapsed, entries]);

  // The distinct files, for the prune calls and the summary line.
  const paths = useMemo(() => [...new Set(entries.map((item) => item.entry.path))], [entries]);

  // Forget patches for files that left the list, and re-read the ones that are
  // still here after the working tree changed. Both sides move together: the
  // reader that has nothing to fetch does nothing.
  useEffect(() => {
    for (const side of SIDES) patches[side].prunePaths(paths);
  }, [paths, patches]);
  useEffect(() => {
    for (const side of SIDES) patches[side].invalidate();
  }, [filesUpdatedAt, patches]);
  // The full-text cache follows the same lifecycle as the patch cache.
  useEffect(() => {
    for (const side of SIDES) contents[side].prune(paths);
  }, [paths, contents]);
  useEffect(() => {
    for (const side of SIDES) contents[side].invalidate();
  }, [filesUpdatedAt, contents]);

  // Only what is on screen (plus a little either side) is asked for. Where
  // the environment has no IntersectionObserver (jsdom, an old webview) the
  // first page is read instead, so the stream still shows diffs rather than
  // nothing at all.
  useEffect(() => {
    if (!isPanelOpen) return;
    const container = scrollRef.current;
    if (container === null) return;
    const ask = (visible: Record<DiffSide, string[]>, overscan: Record<DiffSide, string[]>) => {
      for (const side of SIDES) patches[side].requestPaths({ visible: visible[side], overscan: overscan[side] });
    };
    if (typeof IntersectionObserver === "undefined") {
      const first = entries.slice(0, DIFF_FILES_INLINE_PATCH_MAX_FILES);
      ask(
        { index: first.filter((item) => item.side === "index").map((item) => item.entry.path), worktree: first.filter((item) => item.side === "worktree").map((item) => item.entry.path) },
        { index: [], worktree: [] },
      );
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        const visible: Record<DiffSide, string[]> = { index: [], worktree: [] };
        const overscan: Record<DiffSide, string[]> = { index: [], worktree: [] };
        for (const record of observed) {
          const element = record.target as HTMLElement;
          const path = element.dataset.path;
          const side = element.dataset.side;
          if (path === undefined || (side !== "index" && side !== "worktree")) continue;
          (record.isIntersecting ? visible : overscan)[side].push(path);
        }
        // Anything already loaded stays loaded; the hook filters.
        ask(visible, overscan);
      },
      { root: container, rootMargin: "200px 0px" },
    );
    for (const element of rowRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [entries, isPanelOpen, patches]);

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
    const keys = new Set(entries.map(rowKey));
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
    const element = rowRefs.current.get(rowKey(first));
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
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="vcs-stream-summary">
          {paths.length} file{paths.length === 1 ? "" : "s"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={toggleAll}
          data-testid="vcs-stream-toggle-all"
        >
          <Icon name={allCollapsed ? "ChevronsDown" : "ChevronsUp"} className="size-3.5" />
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-testid="vcs-stream">
        <div className="flex min-w-0 flex-col">
          {entries.map((item) => {
            const key = rowKey(item);
            return (
              <DiffStreamRow
                key={key}
                threadId={threadId}
                entry={item.entry}
                side={item.side}
                patchState={patches[item.side].getPatchState(item.entry.path)}
                contentsState={contents[item.side].getContents(item.entry.path)}
                onRequestContents={() => contents[item.side].requestContents(item.entry.path, item.entry.oldPath)}
                isCollapsed={isCollapsed(key)}
                isMounted={mounted === null || mounted.has(key)}
                onToggleCollapsed={() => toggleCollapsed(key)}
                onLoadPatch={() => patches[item.side].loadPath(item.entry.path)}
                onRetry={() => patches[item.side].retry(item.entry.path)}
                onOpenFile={onOpenFile}
                registerRef={(element) => {
                  if (element === null) rowRefs.current.delete(key);
                  else rowRefs.current.set(key, element);
                }}
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
  side: DiffSide;
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

const STATUS_CLASS: Record<string, string> = {
  M: "text-attention",
  T: "text-attention",
  R: "text-attention",
  A: "text-diff-added",
  C: "text-diff-added",
  D: "text-muted-foreground",
  "?": "text-warning-text",
  U: "text-diff-removed",
};

function DiffStreamRow({
  threadId,
  entry,
  side,
  patchState,
  contentsState,
  onRequestContents,
  isCollapsed,
  isMounted,
  onToggleCollapsed,
  onLoadPatch,
  onRetry,
  onOpenFile,
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
      data-side={side}
      data-testid={`vcs-stream-row-${entry.path}-${side}`}
      className="min-w-0 border-b border-border"
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
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
        <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", STATUS_CLASS[letter] ?? "")} aria-label={`status ${letter}`}>
          {letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground" data-testid={`vcs-stream-side-tag-${entry.path}-${side}`}>
          {SIDE_LABEL[side]}
        </span>
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
              side={side}
              patchState={patchState}
              contentsState={contentsState}
              onRequestContents={onRequestContents}
              onLoadPatch={onLoadPatch}
              onRetry={onRetry}
              onOpenFile={onOpenFile}
            />
          ) : (
            <div
              style={{ height: measuredHeightRef.current ?? estimatedBodyHeight }}
              data-testid={`vcs-stream-spacer-${entry.path}-${side}`}
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
  side,
  patchState,
  contentsState,
  onRequestContents,
  onLoadPatch,
  onRetry,
  onOpenFile,
}: {
  threadId: string;
  entry: ChangeEntry;
  side: DiffSide;
  patchState: DiffPatchState;
  contentsState: DiffContentsState;
  onRequestContents: () => void;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
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
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-loading-${entry.path}-${side}`}>
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
    if (mimeType !== null) {
      return (
        <ImageDiffPreview
          threadId={threadId}
          path={entry.path}
          oldPath={entry.oldPath}
          side={side}
          mimeType={mimeType}
        />
      );
    }
    return (
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-binary-${entry.path}-${side}`}>
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
    <div className="min-w-0 overflow-x-auto" data-testid={`vcs-stream-patch-${entry.path}-${side}`} data-side={side}>
      <PluginDiff
        patch={patchState.patch}
        path={entry.path}
        contents={contentsState.status === "ready" ? contentsState.contents : null}
      />
    </div>
  );
}
