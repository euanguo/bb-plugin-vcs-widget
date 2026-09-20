import type { ChangeEntry } from "../contracts";

export interface ChangeTreeDirectory {
  kind: "directory";
  /** Current path segment only, never an already-expanded full path. */
  name: string;
  /** Full path only for stable state keys and tooltips. */
  path: string;
  children: ChangeTreeNode[];
  entries: ChangeEntry[];
}

export interface ChangeTreeFile {
  kind: "file";
  /** Basename only: parent directories have their own rows. */
  name: string;
  entry: ChangeEntry;
}

export type ChangeTreeNode = ChangeTreeDirectory | ChangeTreeFile;

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: ChangeTreeFile[];
}

function makeDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

/**
 * A real tree of changed paths. It is deliberately built from the current
 * path rather than `oldPath`: a rename lives where it is now, while oldPath
 * remains metadata on the leaf for a tooltip and the diff header.
 */
export function buildChangeTree(entries: readonly ChangeEntry[]): ChangeTreeDirectory {
  const root = makeDirectory("(root)", "");
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    const fileName = segments.pop() ?? entry.path;
    let directory = root;
    for (const segment of segments) {
      const nextPath = directory.path === "" ? segment : `${directory.path}/${segment}`;
      let child = directory.directories.get(segment);
      if (child === undefined) {
        child = makeDirectory(segment, nextPath);
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ kind: "file", name: fileName, entry });
  }
  return freezeDirectory(root);
}

function freezeDirectory(directory: MutableDirectory): ChangeTreeDirectory {
  const directories = [...directory.directories.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(freezeDirectory);
  const files = [...directory.files].sort((a, b) => a.name.localeCompare(b.name));
  const children: ChangeTreeNode[] = [...directories, ...files];
  return {
    kind: "directory",
    name: directory.name,
    path: directory.path,
    children,
    entries: collectEntries(children),
  };
}

function collectEntries(nodes: readonly ChangeTreeNode[]): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const node of nodes) {
    if (node.kind === "file") entries.push(node.entry);
    else entries.push(...node.entries);
  }
  return entries;
}

/**
 * One row of the changed-file list, whichever grouping produced it.
 *
 * A directory header, a status header and a file are all rows of the same list
 * so the list can be windowed with one row height. The headers carry the
 * entries they stand for, which is what their stage-all and discard-all
 * controls act on.
 */
export type ChangeListRow =
  | { kind: "directory"; key: string; depth: number; name: string; path: string; entries: ChangeEntry[] }
  | { kind: "group"; key: string; depth: number; title: string; entries: ChangeEntry[] }
  | {
      kind: "file";
      key: string;
      entry: ChangeEntry;
      /** How far the row steps in, or null for a list that does not step in. */
      depth: number | null;
      /** What the row calls the file: a basename in a tree, the path otherwise. */
      label: string;
      /**
       * Which of the two the label is. A tree labels a file by its basename and
       * leaves the rename to the tooltip; a flat list has no directory row to
       * say where the file is, so it shows the whole path and marks a rename in
       * the label itself.
       */
      labelKind: "name" | "path";
    };

/**
 * The tree as the rows it currently shows: a collapsed directory contributes
 * its own row and nothing below it. Flattened rather than nested because a
 * window is arithmetic over a list, and a tree cannot be sliced without one.
 */
export function flattenChangeTree(root: ChangeTreeDirectory, collapsedPaths: ReadonlySet<string>): ChangeListRow[] {
  const rows: ChangeListRow[] = [];
  const walk = (directory: ChangeTreeDirectory, depth: number) => {
    for (const child of directory.children) {
      if (child.kind === "file") {
        rows.push({ kind: "file", key: child.entry.path, entry: child.entry, depth, label: child.name, labelKind: "name" });
        continue;
      }
      rows.push({ kind: "directory", key: child.path, depth, name: child.name, path: child.path, entries: child.entries });
      if (collapsedPaths.has(child.path)) continue;
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
