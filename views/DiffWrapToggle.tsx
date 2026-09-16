// Whether a long line wraps or scrolls sideways, wherever a diff is shown.
//
// It lives here rather than in each panel because it is one preference with one
// button: the commit panel puts it in the row above its stream, the log panel
// beside the file name in its drawer. Scrolling is the default, because a
// wrapped diff is harder to read line by line and a reader looking at prose in
// a narrow pane is the one who wants the other.
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { usePersistedState } from "../hooks/use-persisted-state";

/** The preference, per thread, so two threads can read differently. */
export function useDiffWrap(threadId: string) {
  return usePersistedState(`vcs-widget.diff-wrap.${threadId}`, false);
}

export function DiffWrapToggle({ wrap, onToggle }: { wrap: boolean; onToggle: () => void }) {
  return (
    <Button
      type="button"
      variant={wrap ? "secondary" : "ghost"}
      size="sm"
      className="h-6 w-6 shrink-0 p-0"
      aria-pressed={wrap}
      aria-label={wrap ? "Wrap long lines" : "Scroll long lines"}
      onClick={onToggle}
      data-testid="vcs-diff-wrap"
    >
      {/* One glyph, held down while it is on: the host's icon set has no
          "wrap off" twin, and a pressed button already says so. */}
      <Icon name="TextWrap" className="size-3.5" />
    </Button>
  );
}
