// The colour of the status letter a file row draws.
//
// Three views draw that letter — the flat/grouped list, the directory tree and
// the diff stream — and they used to carry three copies of the map. The copies
// had already drifted (only one struck a deleted file through), which is the
// bug a single copy removes. The tokens are the host theme's own, so a custom
// theme recolours these the way it recolours bb's diff stats.
const STATUS_CLASS: Record<string, string> = {
  M: "text-attention",
  T: "text-attention",
  R: "text-attention",
  A: "text-diff-added",
  C: "text-diff-added",
  D: "text-muted-foreground line-through",
  "?": "text-warning-text",
  U: "text-diff-removed",
};

export function statusLetterClass(letter: string): string {
  return STATUS_CLASS[letter] ?? "";
}
