// The continuous stream: every changed file's diff stacked in one scrollable
// column, with the file list beside it. A file's patch is read when it comes
// into view (see use-diff-patches), so opening a sixty-file worktree reads
// the few the reader is actually looking at.
//
// A row is one file: a header that stays put while its body scrolls past, and
// a body that is either a diff, a notice (binary, too large, not yet read) or
// nothing at all while collapsed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import type { ChangeEntry } from "../contracts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { diffSidesFor } from "../shared/model";
import type { DiffSide } from "../shared/constants";
import { resolveDiffCollapsed, DIFF_FILES_INLINE_PATCH_MAX_FILES } from "../shared/diff-tiering";
import type { DiffPatchState, UseDiffPatchesResult } from "../hooks/use-diff-patches";

interface ContinuousDiffStreamProps {
  files: readonly ChangeEntry[];
  side: DiffSide;
  patches: UseDiffPatchesResult;
  /** Bumped whenever `changes` arrives, so stale patches are re-read. */
  filesUpdatedAt: unknown;
  isPanelOpen: boolean;
  /** Scroll here when the file list selects a path. */
  scrollToPath: string | null;
  onScrolledToPath: () => void;
  onOpenFile?: (path: string) => void;
  className?: string;
}


/** A status entry is "deleted" when either side says so; otherwise it is a change. */
function initialCollapsed(entry: ChangeEntry, fileCount: number): boolean {
  const deleted = entry.worktree === "D" || entry.index === "D";
  return resolveDiffCollapsed({ fileCount, changeKind: deleted ? "deleted" : "modified" });
}

export function ContinuousDiffStream({
  files,
  side,
  patches,
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

  const isCollapsed = useCallback(
    (entry: ChangeEntry) => collapsed.get(entry.path) ?? initialCollapsed(entry, files.length),
    [collapsed, files.length],
  );

  const toggleCollapsed = useCallback(
    (entry: ChangeEntry) => {
      setCollapsed((previous) => {
        const next = new Map(previous);
        next.set(entry.path, !(previous.get(entry.path) ?? initialCollapsed(entry, files.length)));
        return next;
      });
    },
    [files.length],
  );

  const allCollapsed = files.length > 0 && files.every((entry) => isCollapsed(entry));
  const toggleAll = useCallback(() => {
    const target = !allCollapsed;
    setCollapsed(new Map(files.map((entry) => [entry.path, target])));
  }, [allCollapsed, files]);

  // Forget patches for files that left the list, and re-read the ones that
  // are still here after the working tree changed.
  const { prunePaths, invalidate } = patches;
  useEffect(() => {
    prunePaths(files.map((entry) => entry.path));
  }, [files, prunePaths]);
  useEffect(() => {
    invalidate();
  }, [filesUpdatedAt, invalidate]);

  // Only what is on screen (plus a little either side) is asked for. Where
  // the environment has no IntersectionObserver (jsdom, an old webview) the
  // first page is read instead, so the stream still shows diffs rather than
  // nothing at all.
  useEffect(() => {
    if (!isPanelOpen) return;
    const container = scrollRef.current;
    if (container === null) return;
    if (typeof IntersectionObserver === "undefined") {
      patches.requestPaths({ visible: files.slice(0, DIFF_FILES_INLINE_PATCH_MAX_FILES).map((entry) => entry.path), overscan: [] });
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        const visible: string[] = [];
        const overscan: string[] = [];
        for (const record of observed) {
          const path = (record.target as HTMLElement).dataset.path;
          if (path === undefined) continue;
          (record.isIntersecting ? visible : overscan).push(path);
        }
        // Anything already loaded stays loaded; the hook filters.
        patches.requestPaths({ visible, overscan });
      },
      { root: container, rootMargin: "200px 0px" },
    );
    for (const element of rowRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [files, isPanelOpen, patches]);

  useEffect(() => {
    if (scrollToPath === null) return;
    const element = rowRefs.current.get(scrollToPath);
    if (element === undefined) return;
    element.scrollIntoView({ block: "start" });
    onScrolledToPath();
  }, [scrollToPath, onScrolledToPath]);

  if (files.length === 0) {
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
          {files.length} file{files.length === 1 ? "" : "s"}
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="vcs-stream">
        <div className="flex flex-col gap-2 pt-3">
          {files.map((entry) => (
            <DiffStreamRow
              key={entry.path}
              entry={entry}
              side={side}
              patchState={patches.getPatchState(entry.path)}
              isCollapsed={isCollapsed(entry)}
              onToggleCollapsed={() => toggleCollapsed(entry)}
              onLoadPatch={() => patches.loadPath(entry.path)}
              onRetry={() => patches.retry(entry.path)}
              onOpenFile={onOpenFile}
              registerRef={(element) => {
                if (element === null) rowRefs.current.delete(entry.path);
                else rowRefs.current.set(entry.path, element);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface DiffStreamRowProps {
  entry: ChangeEntry;
  side: DiffSide;
  patchState: DiffPatchState;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
  registerRef: (element: HTMLDivElement | null) => void;
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
  entry,
  side,
  patchState,
  isCollapsed,
  onToggleCollapsed,
  onLoadPatch,
  onRetry,
  onOpenFile,
  registerRef,
}: DiffStreamRowProps) {
  const label = entry.oldPath === null || entry.oldPath === entry.path ? entry.path : `${entry.oldPath} -> ${entry.path}`;
  const letter = statusLetter(entry);

  return (
    <section
      ref={registerRef}
      data-path={entry.path}
      data-testid={`vcs-stream-row-${entry.path}`}
      className="overflow-clip rounded-lg border border-border bg-background"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
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
          entry={entry}
          side={side}
          patchState={patchState}
          onLoadPatch={onLoadPatch}
          onRetry={onRetry}
          onOpenFile={onOpenFile}
        />
      )}
    </section>
  );
}

const NOTICE_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground";

function DiffStreamBody({
  entry,
  side,
  patchState,
  onLoadPatch,
  onRetry,
  onOpenFile,
}: {
  entry: ChangeEntry;
  side: DiffSide;
  patchState: DiffPatchState;
  onLoadPatch: () => void;
  onRetry: () => void;
  onOpenFile?: (path: string) => void;
}) {
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
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-loading-${entry.path}`}>
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
    return (
      <div className={NOTICE_CLASS} data-testid={`vcs-stream-binary-${entry.path}`}>
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
    <div className="overflow-x-auto" data-testid={`vcs-stream-patch-${entry.path}`} data-side={side}>
      <Diff patch={patchState.patch} path={entry.path} view="unified" overflow="scroll" />
    </div>
  );
}
