// The `+3 -1` column a file row carries.
//
// Zero is not shown: a file whose only change is a mode bit, or one git would
// not count, reads better with a blank column than with `+0 -0`. The column
// keeps its width either way, so the checkbox and the discard button beside it
// do not move from row to row.
import { cn } from "@/lib/utils";

interface FileStatsProps {
  additions: number | null;
  deletions: number | null;
  className?: string;
}

export function FileStats({ additions, deletions, className }: FileStatsProps) {
  const added = additions !== null && additions > 0 ? additions : null;
  const removed = deletions !== null && deletions > 0 ? deletions : null;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-end gap-1 font-mono text-[11px] tabular-nums", className)}
      data-testid="vcs-file-stats"
      aria-label={`${additions ?? 0} added, ${deletions ?? 0} deleted`}
    >
      {added === null ? null : <span className="text-diff-added">+{added}</span>}
      {removed === null ? null : <span className="text-diff-removed">-{removed}</span>}
    </span>
  );
}
