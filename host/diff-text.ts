// What every diff read shares: the caps that keep one host payload sane, the
// binary check, and reading one side of a file out of the object database so
// bb's viewer can expand context between hunks.
import { readFile, stat } from "node:fs/promises";
import type { GitError } from "../contracts";
import { classifyGitFailure, type GitPhase } from "../shared/git-errors";
import { runGit, runGitBytes, type GitRunResult } from "./git";
import { readOptions, type ActionContext } from "./actions";

/** One patch in one payload. */
export const PATCH_LIMIT_BYTES = 1024 * 1024;
/** Each complete side handed to the viewer; bigger files render from the patch alone. */
export const SIDE_LIMIT_BYTES = 1024 * 1024;

const BINARY_PATCH = /^Binary files .* differ$|^GIT binary patch$/mu;

export interface CappedPatch {
  patch: string;
  truncated: boolean;
  binary: boolean;
}

export function capPatch(raw: string): CappedPatch {
  const truncated = Buffer.byteLength(raw, "utf8") > PATCH_LIMIT_BYTES;
  return {
    patch: truncated ? Buffer.from(raw, "utf8").subarray(0, PATCH_LIMIT_BYTES).toString("utf8") : raw,
    truncated,
    binary: BINARY_PATCH.test(raw),
  };
}

/** A failed read, named after the panel that asked for it. */
export function readFailure(result: GitRunResult, phase: GitPhase = "read"): GitError {
  return classifyGitFailure({
    phase,
    exitCode: result.code,
    stderr: result.stderr,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  });
}

/**
 * One side of a file as `git show <rev>:<path>`: "" when the path is missing
 * on that side (a new or deleted file), null when it is too big to send, so
 * the caller falls back to the patch alone.
 */
export async function showOrEmpty(context: ActionContext, spec: string): Promise<string | null> {
  const result = await runGit(["--literal-pathspecs", "show", "--end-of-options", spec], readOptions(context));
  if (result.code !== 0) return "";
  return Buffer.byteLength(result.stdout, "utf8") > SIDE_LIMIT_BYTES ? null : result.stdout;
}

/** The viewer takes text, so a side holding NUL is not offered as one. */
export const hasNul = (text: string | null): boolean => text !== null && text.includes("\0");

/**
 * One side of a binary file, as base64. `null` means the side has nothing to
 * show: the path is absent from that revision (a new or deleted file), git
 * cannot read it, or the file is larger than the panel will inline.
 *
 * The bytes come back from `runGitBytes`: decoding an image through a utf8
 * string would replace every invalid sequence with U+FFFD, and the picture
 * would render as corruption rather than as itself.
 */
export async function readImageSide(
  context: ActionContext,
  spec: string,
  maxBytes: number,
): Promise<{ base64: string; sizeBytes: number } | null> {
  const result = await runGitBytes(
    ["--literal-pathspecs", "show", "--end-of-options", spec],
    readOptions(context),
  );
  if (result.code !== 0) return null;
  const bytes = result.stdout;
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  return { base64: bytes.toString("base64"), sizeBytes: bytes.length };
}

/** The worktree's own bytes, for the side the index does not hold. */
export async function readWorktreeImage(
  absolutePath: string,
  maxBytes: number,
): Promise<{ base64: string; sizeBytes: number } | null> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const bytes = await readFile(absolutePath);
    return { base64: bytes.toString("base64"), sizeBytes: bytes.length };
  } catch {
    return null;
  }
}
