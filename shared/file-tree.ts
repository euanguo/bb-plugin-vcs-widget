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
