// Quoting a diff line into the thread composer.
//
// bb's own panel turns a line selection back into a small patch fragment — a
// path, a hunk header, and the lines with their +/- prefixes — which is the
// shape an agent reads best, so this builds the same thing. It works from the
// patch text rather than from the renderer's internals, which keeps it
// independent of @pierre/diffs and cheap to test on its own.

/** Which side of a diff a line number belongs to. */
export type DiffLineSide = "additions" | "deletions";

/** A line range as the diff renderer reports it. Line numbers are 1-based. */
export interface DiffLineRange {
  start: number;
  end: number;
  side?: DiffLineSide | null;
  endSide?: DiffLineSide | null;
}

/** One hunk line, with the line it sits on in each version of the file. */
export interface PatchRow {
  prefix: " " | "+" | "-";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * A unified patch as rows. Only hunk content becomes a row: file headers and
 * git metadata are dropped, because nothing in them can be quoted.
 */
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    // A hunk ends only at the next file. The ---/+++ headers appear before the
    // first @@, never between hunks.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    // The marker git writes when a file has no trailing newline.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      rows.push({ prefix: "+", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ prefix: "-", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    // A context line normally carries a leading space; one whose content is
    // empty arrives with no space at all.
    if (line.startsWith(" ") || line === "") {
      rows.push({ prefix: " ", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
}

function indexOfLine(rows: readonly PatchRow[], line: number, side: DiffLineSide): number {
  return rows.findIndex((row) => (side === "additions" ? row.newLine === line : row.oldLine === line));
}

function lowest(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

/** `1` alone, or `1,3` — the way git writes a hunk header count. */
function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * The quote for a line range: the path, a hunk header, and the selected lines
 * with their prefixes. Returns null when the range names no line the patch
 * actually holds, so a caller never quotes an empty fragment.
 */
export function quoteForRange(patch: string, path: string, lineRange: DiffLineRange): string | null {
  const rows = patchRows(patch);
  const side: DiffLineSide = lineRange.side ?? "additions";
  const first = indexOfLine(rows, lineRange.start, side);
  const last = indexOfLine(rows, lineRange.end, lineRange.endSide ?? side);
  if (first === -1 || last === -1) return null;
  const selected = rows.slice(Math.min(first, last), Math.max(first, last) + 1);
  if (selected.length === 0) return null;

  const oldLines = selected.map((row) => row.oldLine).filter((line): line is number => line !== null);
  const newLines = selected.map((row) => row.newLine).filter((line): line is number => line !== null);
  const oldStart = lowest(oldLines) ?? Math.max(0, (lowest(newLines) ?? 1) - 1);
  const newStart = lowest(newLines) ?? Math.max(0, (lowest(oldLines) ?? 1) - 1);

  return [
    path,
    `@@ -${range(oldStart, oldLines.length)} +${range(newStart, newLines.length)} @@`,
    ...selected.map((row) => `${row.prefix}${row.text}`),
  ].join("\n");
}
