// How much of a file's diff the panel loads, and when. Mirrors bb's own
// diff tiering (apps/server/src/constants.ts + routes/diff-tiering.ts) so the
// continuous stream behaves the way bb's environment diff panel does: a file
// the reader is looking at loads itself, a big one waits for a click, and an
// enormous one is never rendered at all.

/** Files the panel lists at once. */
export const DIFF_FILES_MAX = 500;

/** Above this many changed lines a file waits for a click. */
export const DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES = 500;

/** Above this many changed lines a file is offered as "open it" only. */
export const DIFF_FILE_TOO_LARGE_CHANGED_LINES = 20_000;

/** One patch as the panel receives it. */
export const DIFF_PATCH_MAX_BYTES = 512 * 1024;

/** Paths per batch read; matches bb's DIFF_PATCH_MAX_PATHS_PER_REQUEST. */
export const DIFF_PATCH_MAX_PATHS_PER_REQUEST = 50;

/**
 * Files the server inlines patches for up front. Past this count it inlines
 * none: a stream that size is scrolled, not read, so every patch is fetched
 * when it comes into view.
 */
export const DIFF_FILES_INLINE_PATCH_MAX_FILES = 10;

/** Files past which the stream starts collapsed. */
export const DIFF_AUTO_COLLAPSE_FILE_THRESHOLD = 10;

export type DiffLoadMode = "auto" | "on_demand" | "too_large";

/**
 * Which tier one file falls in. Binary files are always on demand: there is
 * no patch to render, only a preview to ask for.
 */
export function resolveDiffLoadMode({
  changedLines,
  binary,
}: {
  changedLines: number;
  binary: boolean;
}): DiffLoadMode {
  if (changedLines > DIFF_FILE_TOO_LARGE_CHANGED_LINES) return "too_large";
  if (binary || changedLines > DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES) return "on_demand";
  return "auto";
}

/**
 * The paths a first paint inlines patches for: all of them while the list is
 * short, none once it is long enough that the reader will scroll instead.
 */
export function selectInitialPatchPaths(
  files: readonly { path: string; loadMode: DiffLoadMode }[],
): string[] {
  if (files.length > DIFF_FILES_INLINE_PATCH_MAX_FILES) return [];
  return files.filter((file) => file.loadMode === "auto").map((file) => file.path);
}

/** Paths in batches small enough for one read. */
export function chunkDiffPaths(paths: readonly string[]): string[][] {
  const pages: string[][] = [];
  for (let index = 0; index < paths.length; index += DIFF_PATCH_MAX_PATHS_PER_REQUEST) {
    pages.push(paths.slice(index, index + DIFF_PATCH_MAX_PATHS_PER_REQUEST));
  }
  return pages;
}

/** Whether the stream starts collapsed: a long list, or a file that is gone. */
export function resolveDiffCollapsed({
  fileCount,
  changeKind,
}: {
  fileCount: number;
  changeKind: string;
}): boolean {
  return fileCount > DIFF_AUTO_COLLAPSE_FILE_THRESHOLD || changeKind === "deleted";
}

const DIFF_SECTION_HEADER = "diff --git ";

/**
 * One combined patch split back into one patch per file, in the order git
 * printed them. A section keeps its `diff --git` header and everything up to
 * the next one, with trailing blank lines trimmed so a section can be handed
 * to the viewer on its own.
 */
export function splitPatchIntoSections(combinedPatch: string): string[] {
  if (combinedPatch.length === 0) return [];
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of combinedPatch.split("\n")) {
    if (line.startsWith(DIFF_SECTION_HEADER)) {
      if (current !== null) sections.push(current);
      current = [line];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) sections.push(current);
  return sections.map(formatPatchSection);
}

function formatPatchSection(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  if (end === 0) return "";
  const body = lines.slice(0, end);
  const isBinary = body.some((line) => line === "GIT binary patch");
  return `${body.join("\n")}\n${isBinary ? "\n" : ""}`;
}
