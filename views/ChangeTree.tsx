import { useMemo } from "react";
import type { ChangeEntry } from "../contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import { stageState, type FileMenuItemId } from "../shared/model";
import { buildChangeTree, type ChangeTreeDirectory, type ChangeTreeNode } from "../shared/file-tree";
import { ChangeFileRow, INDENT_BASE, INDENT_STEP } from "./ChangeFileRow";

/**
 * How the tree steps in, re-exported because the row owns the numbers and the
 * tree is what a caller reads them from.
 */
export { INDENT_BASE, INDENT_STEP };

interface ChangeTreeProps {
  entries: readonly ChangeEntry[];
  selected: string | null;
  /**
   * Whether the rows can be staged and discarded. A commit or a range shows
   * files that are already committed, where neither means anything; the tick
   * and the discard button are then left out rather than shown disabled, so
   * the row gives its width to the name.
   */
  readOnly: boolean;
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

export function ChangeTree({
  entries,
  selected,
  readOnly,
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
          readOnly={readOnly}
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
  readOnly,
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
        style={{ paddingLeft: `${INDENT_BASE + depth * INDENT_STEP}px` }}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-4 w-4 shrink-0 p-0"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.path || "root"}`}
          aria-expanded={isExpanded}
          onClick={() => onToggleDirectory(node.path)}
        >
          <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        </Button>
        <span className="min-w-0 flex-1 truncate" title={node.path || "(root)"}>{node.name}</span>
        <span className="shrink-0 tabular-nums">({node.entries.length})</span>
        {readOnly ? null : (
          <Checkbox
            checked={allStaged ? true : noneStaged ? false : "indeterminate"}
            aria-label={allStaged ? `Unstage all in ${node.path || "root"}` : `Stage all in ${node.path || "root"}`}
            disabled={disabled || node.entries.some((entry) => pendingPaths.has(entry.path))}
            onCheckedChange={() => onToggleAll(node.entries, !allStaged)}
          />
        )}
      </div>
      {isExpanded ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.kind === "directory" ? child.path : child.entry.path}
              {...{
                entries: [], selected, readOnly, collapsedPaths, disabled, pendingPaths,
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
  readOnly,
  disabled,
  pendingPaths,
  onToggleFile,
  onSelectFile,
  onDiscardFile,
  onMenu,
}: ChangeTreeProps & { node: Extract<ChangeTreeNode, { kind: "file" }>; depth: number }) {
  return (
    <ChangeFileRow
      entry={node.entry}
      label={node.name}
      depth={depth}
      selected={selected === node.entry.path}
      readOnly={readOnly}
      disabled={disabled}
      pending={pendingPaths.has(node.entry.path)}
      onToggle={onToggleFile}
      onSelect={onSelectFile}
      onDiscard={onDiscardFile}
      onMenu={onMenu}
    />
  );
}
