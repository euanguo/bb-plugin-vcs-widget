// The commit panel's host side: what the working tree and the index hold,
// one file's patch with both complete sides, staging, unstaging, discarding,
// and the commit itself as a background job (hooks may run for longer than
// one host call). Every path command runs under --literal-pathspecs so a
// path from `git status` can never turn into a glob or pathspec magic.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ActionResult, ChangeEntry, ChangesResult, CommitInput, DiffBatchResult, DiscardInput, FileDiff, GitError, Head, ImagePreview } from "../contracts";
import { CHANGES_LIMIT, MAX_IMAGE_BYTES, type DiffSide } from "../shared/constants";
import { batchPatches, sideCommand, type BatchDiffEntry } from "./batch-diff";
import { classifyGitFailure, pluginGitError, type GitPhase } from "../shared/git-errors";
import { discardPlans, type GitPlan } from "../shared/model";
import { parseCommitSummary, parseNumstat, parseStatusEntries, parseStatusV2 } from "../shared/parse";
import {
  classifyOr,
  currentBranch,
  fail,
  failureFrom,
  prepared,
  readOptions,
  runPlan,
  succeed,
  type ActionContext,
  type PreparedJob,
} from "./actions";
import { capPatch, hasNul, readFailure, readImageSide, readWorktreeImage, showOrEmpty, SIDE_LIMIT_BYTES } from "./diff-text";
import { gitReadOrNull, runGit } from "./git";
import { detectOperation, isIndexLocked, preflight } from "./repo";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readChanges(context: ActionContext): Promise<ChangesResult> {
  const read = readOptions(context);
  const [statusRaw, logRaw, numstatRaw, operation, indexLocked] = await Promise.all([
    runGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], read),
    // "HEAD --": a file called HEAD in the worktree must not make the
    // revision ambiguous; an unborn branch has no HEAD and yields null.
    gitReadOrNull(["log", "-1", "--format=%H%x00%h%x00%B", "HEAD", "--"], read),
    // Worktree and index together against HEAD: one `+N -M` per file, which
    // is what the file list shows. Null on an unborn branch, which has no
    // HEAD to diff against.
    gitReadOrNull(["diff", "--numstat", "-z", "-M", "HEAD", "--"], read),
    detectOperation(context.repo.gitDir),
    isIndexLocked(context.repo.gitDir),
  ]);
  if (statusRaw.code !== 0) return { ok: false, error: readFailure(statusRaw) };
  const summary = parseStatusV2(statusRaw.stdout);
  const entries = parseStatusEntries(statusRaw.stdout);
  const head: Head | null = summary.detached
    ? { kind: "detached", sha: summary.oid ?? "" }
    : summary.head === null
      ? null
      : summary.oid === null
        ? { kind: "unborn", name: summary.head }
        : { kind: "branch", name: summary.head, sha: summary.oid };
  let lastCommit: Extract<ChangesResult, { ok: true }>["lastCommit"] = null;
  if (logRaw !== null) {
    const [sha = "", shortSha = "", ...rest] = logRaw.split("\0");
    const message = rest.join("\0").replace(/\n+$/u, "");
    if (sha !== "") lastCommit = { sha, shortSha, subject: message.split("\n")[0] ?? "", message };
  }
  const limited = entries.slice(0, CHANGES_LIMIT);
  return {
    ok: true,
    head,
    operation,
    indexLocked,
    files: await withStats(context, limited, numstatRaw, read),
    truncated: entries.length > CHANGES_LIMIT,
    lastCommit,
  };
}

/** How much of one untracked file is read to count its lines. */
const UNTRACKED_COUNT_LIMIT_BYTES = 128 * 1024;
/** How much of all of them together, so a worktree of huge new files cannot stall the read. */
const UNTRACKED_COUNT_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * The lines an untracked file holds, or null when it is not text or too big
 * to read. No diff of an untracked file exists, so counting is the only way
 * to say how much it adds -- which is what a file list wants to show for a
 * new file, and what every other Git UI shows too.
 */
async function countUntrackedLines(context: ActionContext, path: string): Promise<{ lines: number; bytes: number } | null> {
  try {
    const absolute = join(context.repo.repoRoot, path);
    const info = await stat(absolute);
    if (!info.isFile() || info.size > UNTRACKED_COUNT_LIMIT_BYTES) return null;
    const text = await readFile(absolute, "utf8");
    if (hasNul(text)) return null;
    if (text === "") return { lines: 0, bytes: info.size };
    return { lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes: info.size };
  } catch {
    return null;
  }
}

/**
 * Attaches the `+N -M` column to the status rows.
 *
 * Tracked paths take their counts from git's own numstat, which is exact.
 * Untracked paths are counted off disk, because git has nothing to diff them
 * against -- and they are usually most of a new worktree, so leaving them
 * blank would leave the column mostly empty. Anything else (a conflict, a
 * path git did not report) is null rather than zero: the panel says "no
 * numbers" instead of claiming the file changed nothing.
 */
async function withStats(
  context: ActionContext,
  entries: readonly Omit<ChangeEntry, "additions" | "deletions">[],
  numstat: string | null,
  read: ReturnType<typeof readOptions>,
): Promise<ChangeEntry[]> {
  // An unborn branch has no HEAD, so the index against the empty tree is the
  // only baseline there is; `git diff --cached` is exactly that.
  const raw = numstat ?? (await gitReadOrNull(["diff", "--numstat", "-z", "-M", "--cached", "--"], read));
  const tracked = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  if (raw !== null) {
    for (const file of parseNumstat(raw)) tracked.set(file.path, { additions: file.additions, deletions: file.deletions, binary: file.binary });
  }
  const files: ChangeEntry[] = [];
  let countedBytes = 0;
  for (const entry of entries) {
    const known = tracked.get(entry.path);
    if (known !== undefined) {
      files.push({ ...entry, additions: known.binary ? null : known.additions, deletions: known.binary ? null : known.deletions });
      continue;
    }
    if (entry.kind === "untracked" && countedBytes < UNTRACKED_COUNT_BUDGET_BYTES) {
      const counted = await countUntrackedLines(context, entry.path);
      if (counted !== null) {
        countedBytes += counted.bytes;
        files.push({ ...entry, additions: counted.lines, deletions: 0 });
        continue;
      }
    }
    files.push({ ...entry, additions: null, deletions: null });
  }
  return files;
}

async function worktreeFile(context: ActionContext, path: string): Promise<string | null> {
  const absolute = join(context.repo.repoRoot, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return "";
    if (info.size > SIDE_LIMIT_BYTES) return null;
    return await readFile(absolute, "utf8");
  } catch {
    return ""; // deleted in the worktree
  }
}

/**
 * The patch for one file on one side (HEAD → index, or index → working
 * tree) plus, when textual and small, both complete sides so bb's viewer
 * can expand context. An untracked file diffs against /dev/null.
 */
export async function diffFile(
  context: ActionContext,
  input: { path: string; oldPath: string | null; side: DiffSide },
): Promise<FileDiff> {
  const read = readOptions(context);
  const paths = input.oldPath === null || input.oldPath === input.path ? [input.path] : [input.oldPath, input.path];
  const sideArgs = input.side === "index" ? ["--cached"] : [];
  let result = await runGit(
    ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "-M", ...sideArgs, "--", ...paths],
    read,
  );
  if (result.code !== 0) return { ok: false, error: readFailure(result) };
  let untracked = false;
  if (input.side === "worktree" && result.stdout === "") {
    const tracked = await runGit(["--literal-pathspecs", "ls-files", "--", input.path], read);
    if (tracked.code === 0 && tracked.stdout.trim() === "") {
      const exists = await stat(join(context.repo.repoRoot, input.path)).then((info) => info.isFile(), () => false);
      if (exists) {
        untracked = true;
        // Exit 1 means "differs", which a new file always does.
        result = await runGit(["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", input.path], read);
        if (result.code !== 0 && result.code !== 1) return { ok: false, error: readFailure(result) };
      }
    }
  }
  const { patch, truncated, binary } = capPatch(result.stdout);
  let contents: Extract<FileDiff, { ok: true }>["contents"] = null;
  if (!binary && !truncated && patch !== "") {
    const oldPath = input.oldPath ?? input.path;
    const [oldText, newText] =
      input.side === "index"
        ? await Promise.all([showOrEmpty(context, `HEAD:${oldPath}`), showOrEmpty(context, `:${input.path}`)])
        : await Promise.all([untracked ? Promise.resolve("") : showOrEmpty(context, `:${input.path}`), worktreeFile(context, input.path)]);
    if (oldText !== null && newText !== null && !hasNul(oldText) && !hasNul(newText)) {
      contents = { old: { path: oldPath, content: oldText }, new: { path: input.path, content: newText } };
    }
  }
  return { ok: true, path: input.path, side: input.side, patch, truncated, binary, contents };
}

/**
 * One combined git diff for many files on one side, split back into one
 * patch per path. The mechanics -- pairing --name-status -z with the
 * sections of one combined patch -- live in ./batch-diff, because the
 * commit and range targets read patches exactly the same way.
 */
export async function diffFiles(
  context: ActionContext,
  input: { paths: readonly string[]; side: DiffSide },
): Promise<BatchDiffEntry[]> {
  return batchPatches(context, input.paths, sideCommand(input.side));
}

// ---------------------------------------------------------------------------
// Index mutations: never during an index lock, allowed during a merge
// (staging is how a conflict gets resolved).
// ---------------------------------------------------------------------------

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

export async function stage(context: ActionContext, paths: readonly string[]): Promise<ActionResult> {
  const phase: GitPhase = "stage";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  const plan: GitPlan = { op: "stage", paths };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Staged ${files(paths.length)}.`);
}

export async function unstage(context: ActionContext, paths: readonly string[]): Promise<ActionResult> {
  const phase: GitPhase = "stage";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  const plan: GitPlan = { op: "unstage", paths };
  const { result, deadlineMs } = await runPlan(context, plan, "mutate");
  if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  return succeed(context, `Unstaged ${files(paths.length)}.`);
}

/** Runs the previewed discard commands in order; the first failure stops the rest. */
export async function discard(context: ActionContext, input: DiscardInput): Promise<ActionResult> {
  const phase: GitPhase = "discard";
  const plans = discardPlans(input);
  if (plans.length === 0) return fail(context, pluginGitError("git_failed", "Nothing to discard.", phase));
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return fail(context, blocked);
  for (const plan of plans) {
    const { result, deadlineMs } = await runPlan(context, plan, "mutate");
    if (result.code !== 0) return fail(context, failureFrom(phase, result, deadlineMs));
  }
  const total = input.restore.length + input.remove.length + input.clean.length;
  const parts = [
    input.restore.length > 0 ? `reverted ${files(input.restore.length)}` : null,
    input.remove.length > 0 ? `unstaged ${files(input.remove.length)} (kept on disk)` : null,
    input.clean.length > 0 ? `deleted ${files(input.clean.length)}` : null,
  ].filter((part): part is string => part !== null);
  return succeed(context, `Discarded changes in ${files(total)}: ${parts.join(", ")}.`);
}

// ---------------------------------------------------------------------------
// Commit: a job, because hooks can take longer than one host call.
// ---------------------------------------------------------------------------

export async function prepareCommit(
  context: ActionContext,
  input: CommitInput & { timeoutMs: number },
): Promise<PreparedJob | GitError> {
  const phase: GitPhase = "commit";
  const blocked = await preflight(context.repo, phase, { touchesIndex: true, requireNoOperation: false });
  if (blocked) return blocked;
  const status = await runGit(["status", "--porcelain=v2", "-z"], readOptions(context));
  if (status.code !== 0) return failureFrom(phase, status, 0);
  const summary = parseStatusV2(status.stdout);
  if (summary.conflicted > 0) {
    return pluginGitError("conflict", `${files(summary.conflicted)} still conflicted; resolve and stage them first.`, phase);
  }
  const head = await currentBranch(context);
  if (input.amend && head.kind === "unborn") {
    return pluginGitError("ref_not_found", "There is no commit to amend yet.", phase, { hint: "Make the first commit without Amend." });
  }
  if (!input.amend && summary.staged === 0) {
    return pluginGitError("nothing_to_commit", "Nothing is staged.", phase);
  }
  const plan: GitPlan = { op: "commit", amend: input.amend, signoff: input.signoff, noVerify: input.noVerify };
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  return prepared(
    phase,
    plan,
    classifyOr(phase, input.timeoutMs, (run) => {
      const line = parseCommitSummary(run.stdout);
      return {
        ok: true,
        message: line
          ? `${input.amend ? "Amended" : "Committed"} ${line.sha}: ${line.subject}`
          : input.amend
            ? "Amended the last commit."
            : "Committed.",
      };
    }),
    message,
  );
}


/**
 * Both sides of a binary file as base64, for the panel's image preview.
 *
 * The two sides are the ones the requested diff side compares, so the picture
 * agrees with the patch a text file would have shown: the `index` side is
 * HEAD against the index, the `worktree` side is the index against the file
 * on disk. `mimeType` decides whether anything is read at all — a format the
 * panel cannot render costs no git call and no bytes.
 */
export async function imagePreview(
  context: ActionContext,
  input: { path: string; oldPath: string | null; side: DiffSide; mimeType: string },
): Promise<ImagePreview> {
  const oldSpec = input.oldPath === null ? input.path : input.oldPath;
  const [oldSide, newSide] =
    input.side === "index"
      ? await Promise.all([
          readImageSide(context, `HEAD:${oldSpec}`, MAX_IMAGE_BYTES),
          readImageSide(context, `:${input.path}`, MAX_IMAGE_BYTES),
        ])
      : await Promise.all([
          // The index is keyed by the path the row now represents. `oldPath`
          // belongs only to the HEAD → index rename comparison above.
          readImageSide(context, `:${input.path}`, MAX_IMAGE_BYTES),
          readWorktreeImage(join(context.repo.repoRoot, input.path), MAX_IMAGE_BYTES),
        ]);
  return { ok: true, path: input.path, mimeType: input.mimeType, old: oldSide, new: newSide };
}
