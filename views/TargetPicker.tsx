// What the diff pane is pointed at, and what it is measured against.
//
// One control carries both, because they are one question. The dropdown is
// the pane's own answer to "what am I looking at": the working tree, every
// commit this branch holds that the base does not, or one of those commits by
// its subject. The base picker appears beside it only while a range or one of
// its commits is selected, so the uncommitted view keeps the whole row to
// itself -- which is the view most of a commit's life is spent in.
import type { Commit, CompareRef } from "../contracts";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { refLabel } from "../shared/model";
import { compareRefKey, parseCompareRef, parseTargetKey, targetKey, targetLabel, type PanelTarget } from "../shared/target";

/**
 * The trigger prints its own label rather than a `SelectValue`.
 *
 * Radix only learns an item's text once that item has been rendered, which
 * happens when the menu is first opened -- so a value chosen for the reader
 * (or restored from a preference) would show an empty trigger until the menu
 * had been opened once. The two triggers therefore render the same strings
 * the items do, from the same values.
 */
const TRIGGER_LABEL = "min-w-0 flex-1 truncate text-left";

interface TargetPickerProps {
  target: PanelTarget;
  /** The ref a range is measured from; null when the repository has none. */
  base: CompareRef | null;
  bases: readonly CompareRef[];
  /** The commits the range spans, newest first; empty for a single commit. */
  commits: readonly Commit[];
  onSelectTarget: (target: PanelTarget) => void;
  onSelectBase: (base: CompareRef) => void;
}

export function TargetPicker({ target, base, bases, commits, onSelectTarget, onSelectBase }: TargetPickerProps) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        value={targetKey(target)}
        onValueChange={(value) => {
          const next = parseTargetKey(value);
          if (next !== null) onSelectTarget(next);
        }}
      >
        <SelectTrigger
          aria-label="What to diff"
          className="h-6 min-w-0 flex-1 px-1.5 text-xs"
          data-testid="vcs-diff-target"
        >
          <span className={TRIGGER_LABEL} data-testid="vcs-diff-target-label">
            {targetLabel(target, base, commits)}
          </span>
        </SelectTrigger>
        <SelectContent className="max-w-[min(32rem,90vw)]">
          <SelectItem value="uncommitted">Uncommitted changes</SelectItem>
          {base === null ? null : <SelectItem value="commits">All commits vs {refLabel(base)}</SelectItem>}
          {commits.length === 0 ? null : <SelectSeparator />}
          {commits.map((commit) => (
            <SelectItem key={commit.sha} value={"commit:" + commit.sha}>
              <span className="shrink-0 font-mono text-muted-foreground">{commit.shortSha}</span>
              <span className="min-w-0 truncate">{commit.subject}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {target.kind === "uncommitted" ? null : (
        <Select
          value={base === null ? "" : compareRefKey(base)}
          onValueChange={(value) => {
            const next = parseCompareRef(value);
            if (next !== null) onSelectBase(next);
          }}
        >
          <SelectTrigger
            aria-label="Compare against"
            className="h-6 w-28 shrink-0 px-1.5 text-xs"
            data-testid="vcs-diff-base"
          >
            <span className={TRIGGER_LABEL} data-testid="vcs-diff-base-label">
              {base === null ? "No branch" : refLabel(base)}
            </span>
          </SelectTrigger>
          <SelectContent>
            {bases.map((candidate) => (
              <SelectItem key={compareRefKey(candidate)} value={compareRefKey(candidate)}>
                {refLabel(candidate)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
