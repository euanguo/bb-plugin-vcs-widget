// How the file list is grouped. The status grouping is the original one (the
// three buckets git's own status letters fall into); the directory grouping
// answers the case that motivated this: sixty changed files in one flat list
// tell a reader nothing about where the work is.
import type { ChangeEntry } from "../contracts";

export const GROUPING_MODES = ["status", "directory", "flat"] as const;
export type GroupingMode = (typeof GROUPING_MODES)[number];

export function isGroupingMode(value: unknown): value is GroupingMode {
  return typeof value === "string" && (GROUPING_MODES as readonly string[]).includes(value);
}

/** One bucket in the list: a title, the rows under it, and how they nest. */
export interface ChangeGroup {
  /** Stable across re-renders: the directory path, or the status bucket name. */
  key: string;
  title: string;
  /** Directory depth, so the list can indent a nested group. */
  depth: number;
  entries: ChangeEntry[];
}

interface DirectoryNode {
  name: string;
  path: string;
  depth: number;
  entries: ChangeEntry[];
  children: Map<string, DirectoryNode>;
}

function nodeFor(parent: DirectoryNode, name: string, depth: number): DirectoryNode {
  const existing = parent.children.get(name);
  if (existing !== undefined) return existing;
  const created: DirectoryNode = {
    name,
    path: parent.path === "" ? name : `${parent.path}/${name}`,
    depth,
    entries: [],
    children: new Map(),
  };
  parent.children.set(name, created);
  return created;
}

/**
 * The directory tree of the changed files, flattened back into groups in a
 * stable order: a directory's own files first, then its children by name.
 *
 * A group is emitted only for a directory that holds files directly; a
 * directory that merely contains other directories contributes its children
 * and no row of its own, so a deep path does not produce a ladder of empty
 * headers.
 */
export function groupByDirectory(entries: readonly ChangeEntry[]): ChangeGroup[] {
  const root: DirectoryNode = { name: "", path: "", depth: -1, entries: [], children: new Map() };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    segments.pop();
    let node = root;
    for (const segment of segments) {
      node = nodeFor(node, segment, node.depth + 1);
    }
    node.entries.push(entry);
  }

  const groups: ChangeGroup[] = [];
  const walk = (node: DirectoryNode) => {
    if (node.entries.length > 0) {
      groups.push(makeGroup(node.path === "" ? "." : node.path, node.path === "" ? "(root)" : node.path, node.depth, node.entries));
    }
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      walk(child);
    }
  };
  walk(root);
  return groups;
}

function makeGroup(key: string, title: string, depth: number, entries: ChangeEntry[]): ChangeGroup {
  return { key, title, depth: Math.max(0, depth), entries };
}

/** The original three buckets, in the order git users expect them. */
export function groupByStatus(entries: readonly ChangeEntry[]): ChangeGroup[] {
  const buckets: { key: string; title: string; match: (entry: ChangeEntry) => boolean }[] = [
    { key: "conflicts", title: "Conflicts", match: (entry) => entry.kind === "conflicted" },
    { key: "changes", title: "Changes", match: (entry) => entry.kind === "tracked" },
    { key: "untracked", title: "Unversioned files", match: (entry) => entry.kind === "untracked" },
  ];
  return buckets
    .map((bucket) => ({ ...bucket, entries: entries.filter(bucket.match) }))
    .filter((bucket) => bucket.entries.length > 0)
    .map((bucket) => makeGroup(bucket.key, bucket.title, 0, bucket.entries));
}

/** The groups the list renders for one mode. */
export function groupChanges(entries: readonly ChangeEntry[], mode: GroupingMode): ChangeGroup[] {
  if (mode === "flat") {
    return entries.length === 0 ? [] : [makeGroup("all", "All changes", 0, [...entries])];
  }
  if (mode === "directory") return groupByDirectory(entries);
  return groupByStatus(entries);
}

/**
 * The groups ordered by how much each touches, heaviest first. This is the
 * "by file count" reading: the directories with the most work come first
 * instead of alphabetically.
 */
export function sortGroupsByWeight(groups: readonly ChangeGroup[]): ChangeGroup[] {
  return [...groups].sort((a, b) => {
    if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
    return a.key.localeCompare(b.key);
  });
}
