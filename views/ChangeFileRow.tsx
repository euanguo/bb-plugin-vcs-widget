// One changed file, as a row.
//
// Two lists draw this row — the directory tree and the flat / by-status list —
// and they used to carry a copy each. The copies had already drifted (one
// showed the full path, the other the basename; one struck a deleted file
// through and the other did not), so the row lives here once and the list
// chooses only what is genuinely its own: what the file is called and how far
// it steps in.
import { Fragment, type ReactNode } from "react";
import type { ChangeEntry } from "../contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import { fileMenuFor, stageState, statusLetter, type FileMenuItemId } from "../shared/model";
import { statusLetterClass } from "./status-letter";
import { FileStats } from "./FileStats";

/**
 * How the tree steps in. Deliberately small: the file list is a narrow pane,
 * and a four-deep path at a comfortable indent leaves nothing for the names it
 * exists to show. Nine pixels a level still reads as a hierarchy.
 */
export const INDENT_BASE = 6;
export const INDENT_STEP = 9;
/** A tree's file row starts level with its folder's name, past the chevron. */
const FILE_OFFSET = 22;
/** A flat row's inset, which is what `px-2` was worth before this was inline. */
const FLAT_OFFSET = 8;

export interface ChangeFileRowProps {
  entry: ChangeEntry;
  /** What the row calls the file: a basename in the tree, the path when flat. */
  label: ReactNode;
  /** The tree's depth, or null for a list that does not step in. */
  depth: number | null;
  selected: boolean;
  /**
   * Whether the row can be staged and discarded. A commit or a range shows
   * files that are already committed, where neither means anything; the tick
   * and the discard button are then left out rather than shown disabled, so
   * the row gives its width to the name.
   */
  readOnly: boolean;
  disabled: boolean;
  /** This path has a stage/unstage in flight, so the row's own controls wait. */
  pending: boolean;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
  onMenu: (itemId: FileMenuItemId, entry: ChangeEntry) => void;
}

/** The letter IntelliJ shows for a file, as opposed to what git reports. */
export function entryLetter(entry: ChangeEntry): string {
  if (entry.kind === "untracked") return "?";
  if (entry.kind === "conflicted") return "U";
  return statusLetter(entry);
}

export function ChangeFileRow({
  entry,
  label,
  depth,
  selected,
  readOnly,
  disabled,
  pending,
  onToggle,
  onSelect,
  onDiscard,
  onMenu,
}: ChangeFileRowProps) {
  const state = stageState(entry);
  const letter = entryLetter(entry);
  const conflicted = entry.kind === "conflicted";
  const menuItems = fileMenuFor(entry, { blocked: disabled || pending ? "Another VCS action is still running." : null });
  const row = (
    <li
      className={cn(
        "group flex min-w-0 items-center gap-1.5 py-0.5 pr-2 text-xs hover:bg-accent",
        selected && "bg-accent",
      )}
      style={{ paddingLeft: `${depth === null ? FLAT_OFFSET : INDENT_BASE + depth * INDENT_STEP + FILE_OFFSET}px` }}
      data-path={entry.path}
      data-stage={state}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
        aria-pressed={selected}
        onClick={() => onSelect(entry)}
        title={entry.oldPath === null ? entry.path : `${entry.oldPath} → ${entry.path}`}
      >
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", statusLetterClass(letter))} aria-label={`status ${letter}`}>
          {letter}
        </span>
        <span className={cn("min-w-0 flex-1 truncate", state === "partial" && "italic")}>{label}</span>
      </button>
      <FileStats additions={entry.additions} deletions={entry.deletions} />
      {readOnly ? null : (
        <>
          {/* A plain button rather than the vendored one: it drops `title`
              from its props, and this control is exactly what needs one. */}
          <button
            type="button"
            aria-label={`Discard changes in ${entry.path}`}
            title={conflicted ? "Resolve the conflict first." : entry.kind === "untracked" ? "Delete the file" : "Revert to HEAD"}
            disabled={disabled || pending || conflicted}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100"
            onClick={() => onDiscard(entry)}
          >
            <Icon name="RotateCcw" className="size-3.5" />
          </button>
          <Checkbox
            checked={conflicted ? false : state === "staged" ? true : state === "partial" ? "indeterminate" : false}
            aria-label={
              conflicted
                ? `Mark ${entry.path} resolved`
                : state === "unstaged"
                  ? `Stage ${entry.path}`
                  : `Unstage ${entry.path}`
            }
            disabled={disabled || pending}
            onCheckedChange={() => onToggle(entry)}
          />
        </>
      )}
    </li>
  );
  // Nothing to offer on a committed file, so the menu is not attached at all
  // rather than attached with every item disabled.
  if (readOnly) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-48" data-testid="vcs-file-menu" data-path={entry.path}>
        {menuItems.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem disabled={item.disabled} onSelect={() => onMenu(item.id, entry)} data-menu-id={item.id}>
              {item.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
