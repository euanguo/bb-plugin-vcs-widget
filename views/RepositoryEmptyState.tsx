// One empty state for every panel that has no repository to show: the commit
// dialog, the log, the branch comparison and the working-tree diff. bb's own
// record of the thread environment already knows whether the workspace is a
// git repository at all, so the panel can name the situation instead of each
// surface printing its own error paragraph over an otherwise empty layout.
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";
import type { UnavailableKind } from "../contracts";

interface RepositoryEmptyStateProps {
  /** Machine-readable reason; null falls back to the message alone. */
  kind: UnavailableKind | null;
  /** The server's own sentence, shown verbatim under the heading. */
  reason: string;
  /** Read the repository again; omitted where the panel has nothing to repeat. */
  onRetry?: () => void;
}

const HEADINGS: Record<UnavailableKind, string> = {
  no_environment: "No project environment",
  no_workspace: "No workspace path yet",
  provisioning: "The environment is still starting",
  not_a_repo: "Not a Git repository",
  unreadable: "Repository unavailable",
};

const GUIDANCE: Record<UnavailableKind, string> = {
  no_environment: "This thread has no environment for git to run against.",
  no_workspace: "bb has not reported a working directory for this thread yet.",
  provisioning: "The working tree appears as soon as the environment is ready.",
  not_a_repo: "Open a thread whose workspace is inside a Git repository.",
  unreadable: "The repository could not be read on the machine that owns it.",
};

export function RepositoryEmptyState({ kind, reason, onRetry }: RepositoryEmptyStateProps) {
  const resolved = kind ?? "unreadable";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="vcs-repository-empty"
      data-kind={resolved}
    >
      <Icon
        name={resolved === "not_a_repo" ? "GitBranch" : "FileQuestion"}
        fallback="File"
        className="size-6 text-muted-foreground"
      />
      <div className="space-y-1">
        <p className="text-sm font-medium">{HEADINGS[resolved]}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{reason}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{GUIDANCE[resolved]}</p>
      </div>
      {onRetry === undefined ? null : (
        <Button type="button" variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={onRetry}>
          <Icon name="RotateCcw" className="size-3.5" />
          Try again
        </Button>
      )}
    </div>
  );
}
