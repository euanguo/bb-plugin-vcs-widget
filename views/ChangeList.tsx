// The commit panel's changed-file list, windowed.
//
// A directory header, a status header and a file are all rows of one flat list
// so that a single fixed row height can window them. The list used to render
// every row it had — a worktree with four hundred and fifty changed files put
// four hundred and fifty Radix-wrapped rows in the DOM, and every drag of the
// splitter rebuilt them.
import { memo, useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import type { ChangeEntry } from "../contracts";
import { CHANGE_LIST_ROW_HEIGHT, CHANGE_LIST_WINDOW_OVERSCAN } from "../shared/constants";
import type { ChangeListRow } from "../shared/file-tree";
import { stageState, type FileMenuItemId } from "../shared/model";
import { visibleRange } from "../shared/virtual";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import { ChangeFileRow, INDENT_BASE, INDENT_STEP } from "./ChangeFileRow";

export interface ChangeListProps {
  /** The rows the current grouping shows, in order, already flattened. */
  rows: readonly ChangeListRow[];
  selected: string | null;
  /** A commit or a range: nothing to stage and nothing to discard. */
  readOnly: boolean;
  /**
   * A directory row waits while the repository is blocked as well as while an
   * action runs; a status row only waits for the action. The two groupings
   * disagreed about this before the list was windowed, and they still do —
   * unifying them would change what the by-status list offers while an
   * operation holds the repository, which is not this change's to make.
   */
  disabled: boolean;
  busy: boolean;
  pendingPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  /** A header's tick: stage every entry under it, or unstage them all. */
  onToggleAll: (entries: ChangeEntry[], stage: boolean) => void;
  onToggleFile: (entry: ChangeEntry) => void;
  onSelectFile: (entry: ChangeEntry) => void;
  onDiscardFile: (entry: ChangeEntry) => void;
  /** The header's discard, or null where the header has no such control. */
  onDiscardAll: ((entries: ChangeEntry[]) => void) | null;
  onMenu: (itemId: FileMenuItemId, entry: ChangeEntry) => void;
}

export function ChangeList({
  rows,
  selected,
  readOnly,
  disabled,
  busy,
  pendingPaths,
  onToggleDirectory,
  onToggleAll,
  onToggleFile,
  onSelectFile,
  onDiscardFile,
  onDiscardAll,
  onMenu,
}: ChangeListProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLUListElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const window = visibleRange({
    scrollTop,
    viewportHeight,
    rowHeight: CHANGE_LIST_ROW_HEIGHT,
    count: rows.length,
    overscan: CHANGE_LIST_WINDOW_OVERSCAN,
  });

  return (
    <ul
      ref={listRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      data-testid="vcs-change-tree"
    >
      <li aria-hidden data-testid="vcs-change-list-spacer-top" style={{ height: window.topPadding }} />
      {rows.slice(window.start, window.end).map((row) => {
        if (row.kind === "file") {
          return (
            <ChangeFileRow
              key={row.key}
              entry={row.entry}
              label={row.label}
              labelKind={row.labelKind}
              depth={row.depth}
              selected={selected === row.entry.path}
              readOnly={readOnly}
              disabled={row.labelKind === "name" ? disabled : busy}
              pending={pendingPaths.has(row.entry.path)}
              onToggle={onToggleFile}
              onSelect={onSelectFile}
              onDiscard={onDiscardFile}
              onMenu={onMenu}
            />
          );
        }
        if (row.kind === "directory") {
          return (
            <DirectoryRow
              key={row.key}
              row={row}
              readOnly={readOnly}
              disabled={disabled}
              pendingPaths={pendingPaths}
              onToggleDirectory={onToggleDirectory}
              onToggleAll={onToggleAll}
            />
          );
        }
        return (
          <GroupRow
            key={row.key}
            row={row}
            readOnly={readOnly}
            disabled={busy}
            onToggleAll={onToggleAll}
            onDiscardAll={
              onDiscardAll === null || row.entries.some((entry) => entry.kind === "conflicted") ? null : onDiscardAll
            }
          />
        );
      })}
      <li aria-hidden data-testid="vcs-change-list-spacer-bottom" style={{ height: window.bottomPadding }} />
    </ul>
  );
}

/** The header's own text and count, which both kinds share. */
const HEADER_CLASS = "group/header flex items-center gap-2 rounded py-1 pr-2 text-[11px] font-medium text-muted-foreground";

interface DirectoryRowProps {
  row: Extract<ChangeListRow, { kind: "directory" }>;
  readOnly: boolean;
  disabled: boolean;
  pendingPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onToggleAll: (entries: ChangeEntry[], stage: boolean) => void;
}

/**
 * A folder. Collapsing it removes its descendants from the list entirely, so
 * the window sees a shorter list rather than a hidden one — which is also why
 * a row that is drawn is always an expanded one.
 */
const DirectoryRow = memo(function DirectoryRow({
  row,
  readOnly,
  disabled,
  pendingPaths,
  onToggleDirectory,
  onToggleAll,
}: DirectoryRowProps) {
  const allStaged = row.entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = row.entries.every((entry) => stageState(entry) === "unstaged");
  const somePending = row.entries.some((entry) => pendingPaths.has(entry.path));
  return (
    <li
      className={cn(HEADER_CLASS, "my-0.5")}
      style={{ height: CHANGE_LIST_ROW_HEIGHT, paddingLeft: `${INDENT_BASE + row.depth * INDENT_STEP}px` }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-4 w-4 shrink-0 p-0"
        aria-label={`Collapse ${row.path || "root"}`}
        aria-expanded
        onClick={() => onToggleDirectory(row.path)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
      <span className="min-w-0 flex-1 truncate" title={row.path || "(root)"}>{row.name}</span>
      <span className="shrink-0 tabular-nums">({row.entries.length})</span>
      {readOnly ? null : (
        <Checkbox
          checked={allStaged ? true : noneStaged ? false : "indeterminate"}
          aria-label={allStaged ? `Unstage all in ${row.path || "root"}` : `Stage all in ${row.path || "root"}`}
          disabled={disabled || somePending}
          onCheckedChange={() => onToggleAll(row.entries, !allStaged)}
        />
      )}
    </li>
  );
});

interface GroupRowProps {
  row: Extract<ChangeListRow, { kind: "group" }>;
  readOnly: boolean;
  disabled: boolean;
  onToggleAll: (entries: ChangeEntry[], stage: boolean) => void;
  onDiscardAll: ((entries: ChangeEntry[]) => void) | null;
}

/** A status bucket, or the single bucket the flat list shows. */
const GroupRow = memo(function GroupRow({ row, readOnly, disabled, onToggleAll, onDiscardAll }: GroupRowProps) {
  const allStaged = row.entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = row.entries.every((entry) => stageState(entry) === "unstaged");
  const allUntracked = row.entries.every((entry) => entry.kind === "untracked");
  return (
    <li
      className={cn(HEADER_CLASS, "my-0.5")}
      style={{ height: CHANGE_LIST_ROW_HEIGHT, paddingLeft: `${INDENT_BASE + row.depth * INDENT_STEP}px` }}
    >
      <span>{row.title}</span>
      <span className="tabular-nums">({row.entries.length})</span>
      <span className="ml-auto flex items-center gap-2">
        {readOnly || onDiscardAll === null ? null : (
          <button
            type="button"
            aria-label={`Discard all changes in ${row.title}`}
            title={allUntracked ? "Delete every file git does not track here" : "Revert every file here to HEAD"}
            disabled={disabled}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover/header:opacity-100"
            onClick={() => onDiscardAll(row.entries)}
          >
            <Icon name="RotateCcw" className="size-3.5" />
          </button>
        )}
        {readOnly ? null : (
          <Checkbox
            checked={allStaged ? true : noneStaged ? false : "indeterminate"}
            aria-label={allStaged ? `Unstage all in ${row.title}` : `Stage all in ${row.title}`}
            disabled={disabled}
            onCheckedChange={() => onToggleAll(row.entries, !allStaged)}
          />
        )}
      </span>
    </li>
  );
});
