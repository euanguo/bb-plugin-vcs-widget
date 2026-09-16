// One combined `git diff` for many paths, split back into one patch per path.
//
// This is the read the continuous stream runs on: one host call per page of
// files instead of one per file. `--name-status -z` is read alongside the
// patch and the two lists are paired by position, which is what makes a
// rename's two paths resolve to a single entry. When the counts disagree (a
// path vanished between the two reads, or a section carried no `diff --git`
// line) the caller gets one patch per requested path with whatever was found,
// so a stale path costs a blank entry rather than the whole batch.
//
// Every target the diff pane can be pointed at is this same read with
// different revision arguments: one side of the index, a branch range, one
// commit. Keeping the arguments in one place is what stops the four of them
// from drifting apart.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DiffSide } from "../shared/constants";
import { splitPatchIntoSections } from "../shared/diff-tiering";
import { readOptions, type ActionContext } from "./actions";
import { capPatch } from "./diff-text";
import { runGit } from "./git";

/** One file's patch inside a batch read. */
export interface BatchDiffEntry {
  path: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * What to run for one batch. Both commands take `--literal-pathspecs` first
 * and the requested paths after `--`; nothing else about them is shared, so
 * the two are kept side by side rather than derived from one another.
 */
export interface BatchDiffCommand {
  /** The read whose output is split into one section per file. */
  patch: readonly string[];
  /** The same read as names, which is what pairs a section with its path. */
  names: readonly string[];
  /** The same read as line counts, which the file list shows beside the name. */
  numstat: readonly string[];
  /** Whether a path git does not track should be diffed against /dev/null. */
  untracked: boolean;
}

/** HEAD → index. */
const INDEX: BatchDiffCommand = {
  patch: ["diff", "--no-color", "--no-ext-diff", "-M", "--cached"],
  names: ["diff", "--name-status", "-z", "-M", "--cached"],
  numstat: ["diff", "--numstat", "-z", "-M", "--cached"],
  untracked: false,
};

/** index → working tree. */
const WORKTREE: BatchDiffCommand = {
  patch: ["diff", "--no-color", "--no-ext-diff", "-M"],
  names: ["diff", "--name-status", "-z", "-M"],
  numstat: ["diff", "--numstat", "-z", "-M"],
  untracked: true,
};

export function sideCommand(side: DiffSide): BatchDiffCommand {
  return side === "index" ? INDEX : WORKTREE;
}

/** Everything the current branch holds that `base` does not. */
export function rangeCommand(base: string): BatchDiffCommand {
  return {
    patch: ["diff", "--no-color", "--no-ext-diff", "-M", "--end-of-options", `${base}...HEAD`],
    names: ["diff", "--name-status", "-z", "-M", "--end-of-options", `${base}...HEAD`],
    numstat: ["diff", "--numstat", "-z", "-M", "--end-of-options", `${base}...HEAD`],
    untracked: false,
  };
}

/** One commit against its first parent, or against nothing when it is the root. */
export function commitCommand(sha: string, parent: string | null): BatchDiffCommand {
  if (parent === null) {
    return {
      patch: ["show", "--no-color", "--no-ext-diff", "-M", "--format=", "--end-of-options", sha],
      names: ["diff-tree", "--no-commit-id", "--name-status", "-z", "-M", "-r", "--root", "--end-of-options", sha],
      numstat: ["diff-tree", "--no-commit-id", "--numstat", "-z", "-M", "-r", "--root", "--end-of-options", sha],
      untracked: false,
    };
  }
  return {
    patch: ["diff", "--no-color", "--no-ext-diff", "-M", "--end-of-options", parent, sha],
    names: ["diff", "--name-status", "-z", "-M", "--end-of-options", parent, sha],
    numstat: ["diff", "--numstat", "-z", "-M", "--end-of-options", parent, sha],
    untracked: false,
  };
}

export async function batchPatches(
  context: ActionContext,
  paths: readonly string[],
  command: BatchDiffCommand,
): Promise<BatchDiffEntry[]> {
  if (paths.length === 0) return [];
  const read = readOptions(context);
  const blank = (): BatchDiffEntry[] => paths.map((path) => ({ path, patch: "", truncated: false, binary: false }));
  const [patchRaw, nameStatusRaw] = await Promise.all([
    runGit(["--literal-pathspecs", ...command.patch, "--", ...paths], read),
    runGit(["--literal-pathspecs", ...command.names, "--", ...paths], read),
  ]);
  // A batch that fails whole still answers per path, so one unreadable entry
  // cannot blank the stream.
  if (patchRaw.code !== 0 || nameStatusRaw.code !== 0) return blank();
  const entries = parseNameStatusPaths(nameStatusRaw.stdout);
  const sections = splitPatchIntoSections(patchRaw.stdout);
  const patchByPath = new Map<string, string>();
  if (entries.length === sections.length) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const section = sections[index];
      if (entry !== undefined && section !== undefined) patchByPath.set(entry.path, section);
    }
  }
  return Promise.all(
    paths.map(async (path): Promise<BatchDiffEntry> => {
      const raw = patchByPath.get(path);
      if (raw !== undefined) {
        const capped = capPatch(raw);
        return { path, patch: capped.patch, truncated: capped.truncated, binary: capped.binary };
      }
      // `git diff` intentionally omits an untracked file. The single-file
      // reader has always turned it into `--no-index /dev/null`; keep that
      // behavior in the stream too, otherwise an untracked PNG is an empty
      // text diff and can never reach the image preview below it.
      if (!command.untracked || !(await isUntrackedFile(context, path))) {
        return { path, patch: "", truncated: false, binary: false };
      }
      const result = await runGit(
        ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path],
        read,
      );
      // Exit 1 is git's normal "these files differ" result for --no-index.
      if (result.code !== 0 && result.code !== 1) return { path, patch: "", truncated: false, binary: false };
      const capped = capPatch(result.stdout);
      return { path, patch: capped.patch, truncated: capped.truncated, binary: capped.binary };
    }),
  );
}

/** True only for an existing path git does not track. */
export async function isUntrackedFile(context: ActionContext, path: string): Promise<boolean> {
  const read = readOptions(context);
  const tracked = await runGit(["--literal-pathspecs", "ls-files", "--", path], read);
  if (tracked.code !== 0 || tracked.stdout.trim() !== "") return false;
  return stat(join(context.repo.repoRoot, path)).then((info) => info.isFile(), () => false);
}

/**
 * `git diff --name-status -z` as one entry per change. A rename or copy
 * carries its original path in the token after the status letter, which is
 * why the two are read as a pair.
 */
export function parseNameStatusPaths(raw: string): { path: string; oldPath: string | null; letter: string }[] {
  const tokens = raw.split("\0");
  const entries: { path: string; oldPath: string | null; letter: string }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] ?? "";
    if (status.length === 0) continue;
    const letter = status[0] ?? "";
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index + 1] ?? "";
      const path = tokens[index + 2] ?? "";
      index += 2;
      if (path.length > 0) entries.push({ path, oldPath: oldPath.length > 0 ? oldPath : null, letter });
      continue;
    }
    const path = tokens[index + 1] ?? "";
    index += 1;
    if (path.length > 0) entries.push({ path, oldPath: null, letter });
  }
  return entries;
}
