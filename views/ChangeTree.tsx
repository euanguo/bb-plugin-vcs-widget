import { Fragment, useMemo } from "react";
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
import { fileMenuFor, statusLetter, stageState, type FileMenuItemId } from "../shared/model";
import { buildChangeTree, type ChangeTreeDirectory, type ChangeTreeNode } from "../shared/file-tree";

interface ChangeTreeProps {
  entries: readonly ChangeEntry[];
  selected: string | null;
  /** Paths explicitly collapsed by the user; everything else starts open. */
  collapsedPaths: ReadonlySet<string>;
  disabled: boolean;
  pendingPaths: ReadonlySet<string>;
  onToggleDirectory: (path: string) => void;
  onToggleAll: (entries: ChangeEntry[], stage: boolean) => void;
  onToggleFile: (entry: ChangeEntry) => void;
  onSelectFile: (entry: ChangeEntry) => void;
  onDiscardFile: (entry: ChangeEntry) => void;
  onMenu: (item: FileMenuItemId, entry: ChangeEntry) => void;
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

function entryLetter(entry: ChangeEntry) {
  if (entry.kind === "untracked") return "?";
  if (entry.kind === "conflicted") return "U";
  return statusLetter(entry);
}

export function ChangeTree({
  entries,
  selected,
  collapsedPaths,
  disabled,
  pendingPaths,
  onToggleDirectory,
  onToggleAll,
  onToggleFile,
  onSelectFile,
  onDiscardFile,
  onMenu,
}: ChangeTreeProps) {
  const root = useMemo(() => buildChangeTree(entries), [entries]);
  return (
    <ul className="min-w-0 overflow-x-hidden" data-testid="vcs-change-tree">
      {root.children.map((node) => (
        <TreeNode
          key={node.kind === "directory" ? node.path : node.entry.path}
          node={node}
          depth={0}
          entries={[]}
          selected={selected}
          collapsedPaths={collapsedPaths}
          disabled={disabled}
          pendingPaths={pendingPaths}
          onToggleDirectory={onToggleDirectory}
          onToggleAll={onToggleAll}
          onToggleFile={onToggleFile}
          onSelectFile={onSelectFile}
          onDiscardFile={onDiscardFile}
          onMenu={onMenu}
        />
      ))}
    </ul>
  );
}

function TreeNode(props: ChangeTreeProps & { node: ChangeTreeNode; depth: number }) {
  const { node, depth } = props;
  return node.kind === "directory" ? <DirectoryNode {...props} node={node} depth={depth} /> : <FileNode {...props} node={node} depth={depth} />;
}

function DirectoryNode({
  node,
  depth,
  collapsedPaths,
  disabled,
  pendingPaths,
  onToggleDirectory,
  onToggleAll,
  onToggleFile,
  onSelectFile,
  onDiscardFile,
  onMenu,
  selected,
}: ChangeTreeProps & { node: ChangeTreeDirectory; depth: number }) {
  const isExpanded = !collapsedPaths.has(node.path);
  const allStaged = node.entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = node.entries.every((entry) => stageState(entry) === "unstaged");
  return (
    <li className="min-w-0">
      <div
        className="group flex min-w-0 items-center gap-1.5 py-1 pr-2 text-xs font-medium text-muted-foreground"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 shrink-0 p-0"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.path || "root"}`}
          aria-expanded={isExpanded}
          onClick={() => onToggleDirectory(node.path)}
        >
          <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3" />
        </Button>
        <Checkbox
          checked={allStaged ? true : noneStaged ? false : "indeterminate"}
          aria-label={allStaged ? `Unstage all in ${node.path || "root"}` : `Stage all in ${node.path || "root"}`}
          disabled={disabled || node.entries.some((entry) => pendingPaths.has(entry.path))}
          onCheckedChange={() => onToggleAll(node.entries, !allStaged)}
        />
        <span className="min-w-0 flex-1 truncate" title={node.path || "(root)"}>{node.name}</span>
        <span className="shrink-0 tabular-nums">({node.entries.length})</span>
      </div>
      {isExpanded ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.kind === "directory" ? child.path : child.entry.path}
              {...{
                entries: [], selected, collapsedPaths, disabled, pendingPaths,
                onToggleDirectory, onToggleAll, onToggleFile, onSelectFile, onDiscardFile, onMenu,
              }}
              node={child}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileNode({
  node,
  depth,
  selected,
  disabled,
  pendingPaths,
  onToggleFile,
  onSelectFile,
  onDiscardFile,
  onMenu,
}: ChangeTreeProps & { node: Extract<ChangeTreeNode, { kind: "file" }>; depth: number }) {
  const entry = node.entry;
  const state = stageState(entry);
  const letter = entryLetter(entry);
  const pending = pendingPaths.has(entry.path);
  const menuItems = fileMenuFor(entry, { blocked: disabled || pending ? "Another VCS action is still running." : null });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn("group flex min-w-0 items-center gap-2 py-0.5 pr-2 text-xs hover:bg-accent", selected === entry.path && "bg-accent")}
          style={{ paddingLeft: `${8 + depth * 14 + 20}px` }}
          data-path={entry.path}
        >
      <Checkbox
        checked={entry.kind === "conflicted" ? false : state === "staged" ? true : state === "partial" ? "indeterminate" : false}
        aria-label={entry.kind === "conflicted" ? `Mark ${entry.path} resolved` : state === "unstaged" ? `Stage ${entry.path}` : `Unstage ${entry.path}`}
        disabled={disabled || pending}
        onCheckedChange={() => onToggleFile(entry)}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
        aria-pressed={selected === entry.path}
        onClick={() => onSelectFile(entry)}
        title={entry.oldPath === null ? entry.path : `${entry.oldPath} → ${entry.path}`}
      >
        <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", STATUS_CLASS[letter] ?? "")} aria-label={`status ${letter}`}>{letter}</span>
        <span className={cn("min-w-0 flex-1 truncate", state === "partial" && "italic")}>{node.name}</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 w-5 shrink-0 p-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Discard changes in ${entry.path}`}
        disabled={disabled || pending || entry.kind === "conflicted"}
        onClick={() => onDiscardFile(entry)}
      >
        <Icon name="RotateCcw" className="size-3.5" />
          </Button>
        </li>
      </ContextMenuTrigger>
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
