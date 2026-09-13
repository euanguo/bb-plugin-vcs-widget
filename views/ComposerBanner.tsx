// The strip above the message box: the branch, how much there is to commit,
// and the two agent buttons. It runs no git of its own — it reads the same
// overview the popup reads, and its buttons take the same `sendToAgent` path
// the commit panel's do, so the plugin still has exactly two things it can
// say to an agent.
import { useCallback, useState } from "react";
import { useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import { AGENT_ACTIONS, AGENT_ACTION_VARIANTS, type AgentActionVariant } from "../shared/constants";
import { commitBannerFor } from "../shared/model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function ComposerBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  return threadId === null ? null : <ThreadBanner threadId={threadId} />;
}

function ThreadBanner({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = useSidebarThread(threadId);
  const [sending, setSending] = useState(false);

  // Unlike the popup, this reads without being asked: it has to know whether
  // there is anything to commit before it can decide to show at all. A thread
  // bb has no environment for is not read. Hidden and archived threads are
  // off the sidebar list, so their environment can only come from the read.
  const offSidebar = sidebar.status === "ready" && !sidebar.found;
  const { overview } = useOverview({
    threadId,
    environmentId: sidebar.environmentId,
    enabled: sidebar.environmentId !== null || offSidebar,
  });

  const askAgent = useCallback(
    async (variant: AgentActionVariant) => {
      const { message: sent } = AGENT_ACTIONS[variant];
      setSending(true);
      try {
        const result = await rpc.call("sendToAgent", { threadId, variant });
        if (!result.ok) toast.error(result.error.message);
        else if (result.delivery === "queued") {
          toast.success(`“${sent}” is queued; the agent takes it when the current turn ends.`);
        } else toast.success(`“${sent}” sent to the agent.`);
      } catch (cause) {
        toast.error(errorMessage(cause));
      } finally {
        setSending(false);
      }
    },
    [rpc, threadId],
  );

  const banner = commitBannerFor(overview);
  if (banner === null) return null;

  return (
    // The host card draws the border and nothing else, so the inset is ours:
    // bb's own rows in this stack are a `p-1` card around `min-h-6 px-2 py-1`
    // segments, which is what puts this one on their grid.
    <div className="flex flex-wrap items-center gap-1 p-1 text-xs" data-testid="vcs-composer-banner">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 px-2 py-1 text-muted-foreground">
        <Icon name="GitBranch" className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 max-w-40 truncate font-medium text-foreground" title={banner.branch}>
          {banner.branch}
        </span>
        <span className="shrink-0" title={banner.detail} data-testid="vcs-composer-count">
          {banner.count} to commit
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {AGENT_ACTION_VARIANTS.map((variant) => {
          const action = AGENT_ACTIONS[variant];
          // The same sentence the commit panel's buttons carry: the message is
          // fixed, it goes to this thread as if typed, and no git runs here.
          const explains = `Sends “${action.message}” to this thread's agent, as if you had typed it. Runs no git here.`;
          // The title sits on a wrapper because the vendored Button drops
          // `title` from its props.
          return (
            <span key={variant} title={explains} className="inline-flex">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-xs"
                aria-label={`${action.label}: ${explains}`}
                disabled={sending}
                onClick={() => void askAgent(variant)}
                data-testid={`vcs-composer-${variant}-button`}
              >
                <Icon name="Sent" className="size-3.5" aria-hidden />
                {action.label}
              </Button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
