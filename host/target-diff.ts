// The diff pane pointed at something other than the working tree: every
// commit this branch holds that a base branch does not, or one commit of
// them.
//
// Only the patch read lives here. The file list for a range is `compare`'s
// and for a commit is `commitDetails`'s, both of which already count the
// lines; duplicating that here would give the panel two answers to one
// question.
import type { ChangeEntry, DiffBatchResult, DiffTarget, GitError, TargetFiles } from "../contracts";
import { LOG_FORMAT, parseLog, parseNumstat } from "../shared/parse";
import { readOptions, type ActionContext } from "./actions";
import { batchPatches, commitCommand, parseNameStatusPaths, rangeCommand, type BatchDiffCommand } from "./batch-diff";
import { COMMIT_LIMIT, verifyRef } from "./compare";
import { readFailure } from "./diff-text";
import { runGit } from "./git";
import { resolveCommit } from "./log";

const isError = (value: unknown): value is GitError => typeof value === "object" && value !== null && "code" in value;

export async function diffTargetPatches(
  context: ActionContext,
  input: { target: DiffTarget; paths: readonly string[] },
): Promise<DiffBatchResult> {
  if (input.target.kind === "commits") {
    const base = await verifyRef(context, input.target.base);
    if (typeof base !== "string") return { ok: false, error: base };
    return { ok: true, files: await batchPatches(context, input.paths, rangeCommand(base)) };
  }
  const resolved = await resolveCommit(context, input.target.sha);
  if (isError(resolved)) return { ok: false, error: resolved };
  return { ok: true, files: await batchPatches(context, input.paths, commitCommand(resolved.sha, resolved.parent)) };
}

/**
 * The rows the panel renders for a target, plus the commits a range spans so
 * the picker can offer them.
 *
 * `--name-status` supplies the status letter and `--numstat` the counts; the
 * two are paired by position, the same way ./batch-diff pairs a section with
 * its name, because git prints them in the same order for the same diff. A
 * path whose pair is missing keeps the letter and loses the counts, which is
 * what the panel shows for a binary anyway.
 */
export async function diffTarget(
  context: ActionContext,
  input: { target: DiffTarget },
): Promise<TargetFiles | { ok: false; error: GitError }> {
  const read = readOptions(context);
  let command: BatchDiffCommand;
  let commits: string[] | null = null;
  if (input.target.kind === "commits") {
    const base = await verifyRef(context, input.target.base);
    if (typeof base !== "string") return { ok: false, error: base };
    command = rangeCommand(base);
    // `base..HEAD`: the commits this branch holds that the base does not.
    commits = ["log", `--format=${LOG_FORMAT}`, "-n", String(COMMIT_LIMIT + 1), "--end-of-options", `${base}..HEAD`, "--"];
  } else {
    const resolved = await resolveCommit(context, input.target.sha);
    if (isError(resolved)) return { ok: false, error: resolved };
    command = commitCommand(resolved.sha, resolved.parent);
  }
  const [namesRaw, numstatRaw, commitsRaw] = await Promise.all([
    runGit(["--literal-pathspecs", ...command.names, "--"], read),
    runGit(["--literal-pathspecs", ...command.numstat, "--"], read),
    commits === null ? Promise.resolve(null) : runGit(commits, read),
  ]);
  if (namesRaw.code !== 0 || numstatRaw.code !== 0) return { ok: false, error: readFailure(namesRaw.code !== 0 ? namesRaw : numstatRaw) };
  const names = parseNameStatusPaths(namesRaw.stdout);
  const counts = parseNumstat(numstatRaw.stdout);
  const files: ChangeEntry[] = names.map((name, index) => {
    const count = counts[index];
    const binary = count?.binary ?? false;
    return {
      path: name.path,
      oldPath: name.oldPath,
      // A target has no index side: the letter is the diff's own, and the
      // panel renders these rows read-only.
      index: ".",
      worktree: name.letter,
      kind: "tracked",
      additions: binary ? null : (count?.additions ?? null),
      deletions: binary ? null : (count?.deletions ?? null),
    };
  });
  const parsed = commitsRaw === null || commitsRaw.code !== 0 ? [] : parseLog(commitsRaw.stdout);
  return { ok: true, files, commits: parsed.slice(0, COMMIT_LIMIT), truncated: parsed.length > COMMIT_LIMIT };
}
