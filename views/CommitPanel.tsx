// The commit dialog as a thread panel tab: the working tree and the index
// as a checklist (the checkbox is the staged state), bb's diff viewer for
// the selected file, the message, and Commit / Commit and Push. Every
// mutation goes through useVcsActions, so discards and amends ask first with
// the exact command and the commit runs as a job on the host.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Diff as Diff, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangeEntry, FileDiff } from "../contracts";
import { useChanges } from "../hooks/use-changes";
import { useDiffPatches } from "../hooks/use-diff-patches";
import { useJobs } from "../hooks/use-jobs";
import { useOverview } from "../hooks/use-overview";
import { useSidebarThread } from "../hooks/use-sidebar-thread";
import { useVcsActions } from "../hooks/use-vcs-actions";
import { errorMessage } from "../lib/errors";
import type { rpcContract } from "../server";
import { AGENT_ACTIONS, AGENT_ACTION_VARIANTS, type AgentActionVariant, type DiffSide } from "../shared/constants";
import {
  commitBlockedReason,
  diffSidesFor,
  fileMenuFor,
  headLabel,
  isStaged,
  stageState,
  statusLetter,
  type FileMenuItemId,
} from "../shared/model";
import { groupChanges, isGroupingMode, sortGroupsByWeight, type GroupingMode } from "../shared/grouping";
import { ConfirmStep } from "./ConfirmStep";
import { ContinuousDiffStream } from "./ContinuousDiffStream";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface PanelProps {
  threadId: string;
  params: unknown;
}

/**
 * The status letter's colour, in the host theme's tokens so it follows a
 * custom theme the way bb's own diff stats do.
 */
const LETTER_CLASS: Record<string, string> = {
  M: "text-attention",
  T: "text-attention",
  R: "text-attention",
  A: "text-diff-added",
  C: "text-diff-added",
  D: "text-muted-foreground line-through",
  "?": "text-warning-text",
  U: "text-diff-removed",
};

/** The paths one row stands for: a staged rename is two index entries. */
function pathsOf(entry: ChangeEntry): string[] {
  return entry.index === "R" && entry.oldPath !== null ? [entry.path, entry.oldPath] : [entry.path];
}

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-4 text-sm text-muted-foreground">{children}</p>;
}

interface RowProps {
  entry: ChangeEntry;
  selected: boolean;
  disabled: boolean;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
  onMenu: (itemId: FileMenuItemId, entry: ChangeEntry) => void;
}

function Row({ entry, selected, disabled, onToggle, onSelect, onDiscard, onMenu }: RowProps) {
  const state = stageState(entry);
  const letter = statusLetter(entry);
  const conflicted = entry.kind === "conflicted";
  const items = fileMenuFor(entry, { blocked: disabled ? "Another VCS action is still running." : null });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn("group flex items-center gap-2 px-2 py-0.5 text-xs hover:bg-accent", selected && "bg-accent")}
          data-path={entry.path}
          data-stage={state}
        >
          <Checkbox
            checked={conflicted ? false : state === "staged" ? true : state === "partial" ? "indeterminate" : false}
            aria-label={conflicted ? `Mark ${entry.path} resolved` : state === "unstaged" ? `Stage ${entry.path}` : `Unstage ${entry.path}`}
            disabled={disabled}
            onCheckedChange={() => onToggle(entry)}
          />
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
            aria-pressed={selected}
            onClick={() => onSelect(entry)}
            title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
          >
            <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", LETTER_CLASS[letter] ?? "")} aria-label={`status ${letter}`}>
              {letter}
            </span>
            <span className={cn("min-w-0 flex-1 truncate", state === "partial" && "italic")}>
              {entry.oldPath ? <span className="text-muted-foreground">{entry.oldPath} → </span> : null}
              {entry.path}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Discard changes in ${entry.path}`}
            title={conflicted ? "Resolve the conflict first." : entry.kind === "untracked" ? "Delete the file" : "Revert to HEAD"}
            disabled={disabled || conflicted}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover:opacity-100"
            onClick={() => onDiscard(entry)}
          >
            <Icon name="RotateCcw" className="size-3.5" />
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48" data-testid="vcs-file-menu" data-path={entry.path}>
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              disabled={item.disabled}
              title={item.reason ?? undefined}
              onSelect={() => onMenu(item.id, entry)}
              data-menu-id={item.id}
            >
              {item.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface GroupProps {
  title: string;
  /** Directory depth, so a nested group indents its header. */
  depth: number;
  entries: ChangeEntry[];
  selected: string | null;
  disabled: boolean;
  /** Paths with a stage/unstage in flight; only these rows grey out. */
  pendingPaths: ReadonlySet<string>;
  /** The header checkbox: stage all, or unstage all when everything is staged. */
  onToggleAll: (entries: ChangeEntry[], stageThem: boolean) => void;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
  onMenu: (itemId: FileMenuItemId, entry: ChangeEntry) => void;
  /** Header discard, VS Code's "Discard All Changes"; null where nothing can be discarded. */
  onDiscardAll: ((entries: ChangeEntry[]) => void) | null;
}

function Group({ title, depth, entries, selected, disabled, pendingPaths, onToggleAll, onToggle, onSelect, onDiscard, onMenu, onDiscardAll }: GroupProps) {
  if (entries.length === 0) return null;
  const allStaged = entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = entries.every((entry) => stageState(entry) === "unstaged");
  const allUntracked = entries.every((entry) => entry.kind === "untracked");
  return (
    <section aria-label={title}>
      <header
        className="group/header flex items-center gap-2 py-1 pr-2 text-[11px] font-medium text-muted-foreground"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <Checkbox
          checked={allStaged ? true : noneStaged ? false : "indeterminate"}
          aria-label={allStaged ? `Unstage all in ${title}` : `Stage all in ${title}`}
          disabled={disabled}
          onCheckedChange={() => onToggleAll(entries, !allStaged)}
        />
        <span>{title}</span>
        <span className="tabular-nums">({entries.length})</span>
        {onDiscardAll !== null ? (
          <button
            type="button"
            aria-label={`Discard all changes in ${title}`}
            title={allUntracked ? "Delete every file git does not track here" : "Revert every file here to HEAD"}
            disabled={disabled}
            className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover/header:opacity-100"
            onClick={() => onDiscardAll(entries)}
          >
            <Icon name="RotateCcw" className="size-3.5" />
          </button>
        ) : null}
      </header>
      <ul>
        {entries.map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            selected={selected === entry.path}
            disabled={disabled || pendingPaths.has(entry.path)}
            onToggle={onToggle}
            onSelect={onSelect}
            onDiscard={onDiscard}
            onMenu={onMenu}
          />
        ))}
      </ul>
    </section>
  );
}

export function CommitPanel({ threadId }: PanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = useSidebarThread(threadId);
  const { changes, loading, error, refetch, applyStaged } = useChanges(threadId);
  const { overview, applyOverview } = useOverview({ threadId, environmentId: sidebar.environmentId, enabled: true });
  const jobs = useJobs(threadId);
  // Quiet: the status line under the buttons reports every outcome, and bb's
  // toasts would stack right over this form.
  const actions = useVcsActions({ threadId, overview, applyOverview, onCheckedOut: () => undefined, waitForJob: jobs.waitFor, quiet: true, applyStaged });

  const [selected, setSelected] = useState<string | null>(null);
  // Which paths have a stage/unstage in flight. The list disables only those
  // rows, not every row: a global `busy` turned the whole list half-opaque
  // for the length of one round trip, which is the flicker this fixes.
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  // A file-list click scrolls the stream to that file rather than swapping
  // what the pane shows; the request is cleared once it has been honoured.
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  // What the two things that are not git actions report: the copied path and
  // the message handed to the agent. The action status line below is
  // `actions.status`, and neither of these produces one.
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [runHooks, setRunHooks] = useState(true);
  // The message Amend filled in, so turning it off can clear it again.
  const prefilled = useRef<string | null>(null);

  // Every successful `changes` read is a new object, so its identity is what
  // tells the stream that a cached patch may now describe an older tree.
  const changesUpdatedAt = changes;

  const files = useMemo(() => (changes?.ok ? changes.files : []), [changes]);
  // How the file list is grouped. Directory answers the flat-list problem:
  // sixty files in one column say nothing about where the work is.
  const [grouping, setGrouping] = useState<GroupingMode>("status");
  const [heaviestFirst, setHeaviestFirst] = useState(false);
  const groups = useMemo(() => {
    const grouped = groupChanges(files, grouping);
    return heaviestFirst ? sortGroupsByWeight(grouped) : grouped;
  }, [files, grouping, heaviestFirst]);
  const stagedCount = files.filter(isStaged).length;
  // The stream reads one side at a time, which is what lets a batch read stay
  // one host call per page. Unstaged first: reviewing what is not yet in the
  // index is the common case.
  const [streamSide, setStreamSide] = useState<DiffSide>("worktree");
  const streamFiles = useMemo(
    () => files.filter((candidate) => diffSidesFor(candidate).includes(streamSide)),
    [files, streamSide],
  );
  const patches = useDiffPatches(threadId, streamSide, true);

  const blocked = commitBlockedReason(overview, changes);
  const busy = actions.busy;
  const disabled = busy || blocked !== null;
  const lastCommit = changes?.ok ? changes.lastCommit : null;
  const head = changes?.ok ? changes.head : null;
  const label = headLabel(overview, sidebar.branchName);

  const toggle = useCallback(
    (target: ChangeEntry) => {
      const state = stageState(target);
      const paths = pathsOf(target);
      setPendingPaths((current) => new Set([...current, ...paths]));
      const clear = () =>
        setPendingPaths((current) => {
          const next = new Set(current);
          for (const path of paths) next.delete(path);
          return next;
        });
      const run = target.kind === "conflicted" || state === "unstaged" ? actions.stage(paths) : actions.unstage(paths);
      void run.finally(clear);
    },
    [actions],
  );
  const toggleAll = useCallback(
    (entries: ChangeEntry[], stageThem: boolean) => {
      const paths = entries
        .filter((candidate) => (stageThem ? stageState(candidate) !== "staged" : stageState(candidate) !== "unstaged"))
        .flatMap(pathsOf);
      if (paths.length === 0) return;
      setPendingPaths((current) => new Set([...current, ...paths]));
      const clear = () =>
        setPendingPaths((current) => {
          const next = new Set(current);
          for (const path of paths) next.delete(path);
          return next;
        });
      const run = stageThem ? actions.stage(paths) : actions.unstage(paths);
      void run.finally(clear);
    },
    [actions],
  );

  const discardOne = useCallback(
    (target: ChangeEntry) => {
      setNotice(null);
      actions.discard([target]);
    },
    [actions],
  );

  /** VS Code's "Discard All Changes": one dialog, one call, the whole group. */
  const discardAll = useCallback(
    (entries: ChangeEntry[]) => {
      setNotice(null);
      actions.discard(entries);
    },
    [actions],
  );

  const onFileMenu = useCallback(
    (itemId: FileMenuItemId, target: ChangeEntry) => {
      if (itemId === "discard") {
        discardOne(target);
        return;
      }
      // The row shows the repository-relative path, so that is what it copies;
      // a rename copies the new path, the one it lives at now.
      void navigator.clipboard?.writeText(target.path).then(
        () => setNotice({ kind: "ok", text: `Copied ${target.path}` }),
        () => setNotice({ kind: "error", text: "Could not copy the path." }),
      );
    },
    [discardOne],
  );

  /**
   * Hands the commit to the agent in this thread. Always available: the human
   * has read the diff here, and whether the agent is mid-turn is the server's
   * problem (it queues). The variant picks which of the two fixed messages
   * goes; the panel never sends the text.
   */
  const askAgent = useCallback(
    async (variant: AgentActionVariant) => {
      const { message: sent } = AGENT_ACTIONS[variant];
      setSending(true);
      setNotice(null);
      actions.clearStatus();
      try {
        const result = await rpc.call("sendToAgent", { threadId, variant });
        setNotice(
          result.ok
            ? {
                kind: "ok",
                text:
                  result.delivery === "queued"
                    ? `“${sent}” is queued; the agent takes it when the current turn ends.`
                    : `“${sent}” sent to the agent.`,
              }
            : { kind: "error", text: result.error.message },
        );
      } catch (cause) {
        setNotice({ kind: "error", text: errorMessage(cause) });
      } finally {
        setSending(false);
      }
    },
    [actions, rpc, threadId],
  );

  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (on && message.trim() === "" && lastCommit !== null) {
      setMessage(lastCommit.message);
      prefilled.current = lastCommit.message;
    } else if (!on && prefilled.current !== null && message === prefilled.current) {
      setMessage("");
      prefilled.current = null;
    }
  };

  const canCommit = !disabled && message.trim().length > 0 && (amend || stagedCount > 0) && head !== null;
  const canPush = canCommit && overview !== null && overview.remotes.length > 0 && overview.head?.kind === "branch";

  const submit = (andPush: boolean) => {
    if (!canCommit) return;
    actions.commit(
      { message, amend, signoff, noVerify: !runHooks },
      {
        andPush,
        onDone: (result) => {
          if (!result.ok) return;
          setMessage("");
          setAmend(false);
          prefilled.current = null;
        },
      },
    );
  };

  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit(false);
    }
  };

  const status = actions.status;
  const progress = jobs.progress;

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" data-testid="vcs-commit-panel">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Check" className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Commit</span>
        <span className="min-w-0 truncate text-muted-foreground" data-testid="vcs-commit-branch">
          {label}
        </span>
        <span className="ml-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground" data-testid="vcs-commit-counts">
          {changes?.ok ? `${stagedCount} staged · ${files.length - stagedCount} unstaged` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" aria-label="Refresh" onClick={refetch} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </header>

      {/* Left: every changed file's diff, stacked. Right: the file list. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="shrink-0 text-xs text-muted-foreground">Diff</span>
            <div role="group" aria-label="Diff side" className="flex gap-1">
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-xs"
                variant={streamSide === "worktree" ? "secondary" : "ghost"}
                onClick={() => setStreamSide("worktree")}
                aria-pressed={streamSide === "worktree"}
                data-testid="vcs-stream-side-worktree"
              >
                Unstaged
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-xs"
                variant={streamSide === "index" ? "secondary" : "ghost"}
                onClick={() => setStreamSide("index")}
                aria-pressed={streamSide === "index"}
                data-testid="vcs-stream-side-index"
              >
                Staged
              </Button>
            </div>
          </div>
          <ContinuousDiffStream
            files={streamFiles}
            side={streamSide}
            patches={patches}
            filesUpdatedAt={changesUpdatedAt}
            isPanelOpen
            scrollToPath={scrollToPath}
            onScrolledToPath={() => setScrollToPath(null)}
            onOpenFile={undefined}
          />
        </div>

        <div
          className="flex min-h-0 w-72 shrink-0 flex-col overflow-y-auto"
          aria-label="Changed files"
          data-testid="vcs-file-list"
        >
          {error !== null ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : changes === null ? (
            <Empty>Reading the working tree…</Empty>
          ) : !changes.ok ? (
            <p className="p-4 text-sm text-destructive">{changes.error.message}</p>
          ) : files.length === 0 ? (
            <Empty>Nothing to commit: the working tree is clean.</Empty>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                <Select value={grouping} onValueChange={(value) => { if (isGroupingMode(value)) setGrouping(value); }}>
                  <SelectTrigger
                    aria-label="Group changed files by"
                    className="h-6 min-w-0 flex-1 px-1 text-xs"
                    data-testid="vcs-grouping-mode"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="status">By status</SelectItem>
                    <SelectItem value="directory">By directory</SelectItem>
                    <SelectItem value="flat">Flat</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant={heaviestFirst ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 shrink-0 px-2 text-xs"
                  aria-pressed={heaviestFirst}
                  aria-label="Order groups by how many files each holds"
                  onClick={() => setHeaviestFirst((value) => !value)}
                  data-testid="vcs-grouping-heaviest"
                >
                  <Icon name="ArrowUpDown" className="size-3.5" />
                </Button>
              </div>
              {groups.map((group) => (
                <Group
                  key={group.key}
                  title={group.title}
                  depth={group.depth}
                  entries={group.entries}
                  selected={selected}
                  disabled={busy}
                  pendingPaths={pendingPaths}
                  onToggleAll={toggleAll}
                  onToggle={toggle}
                  onSelect={(next) => {
                    setSelected(next.path);
                    setScrollToPath(next.path);
                  }}
                  onDiscard={discardOne}
                  onMenu={onFileMenu}
                  onDiscardAll={group.entries.some((entry) => entry.kind === "conflicted") ? null : discardAll}
                />
              ))}
              {changes.truncated ? <p className="px-2 py-1 text-xs text-muted-foreground">Only the first {files.length} files are listed.</p> : null}
            </>
          )}
        </div>
      </div>

      <form
        className="shrink-0 space-y-2 border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        <Textarea
          aria-label="Commit message"
          placeholder={amend ? "Amended commit message" : "Commit message"}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onMessageKeyDown}
          disabled={busy}
          className="min-h-[3.5rem] resize-y font-mono text-xs"
          data-testid="vcs-commit-message"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <label className="flex items-center gap-1.5">
            <Checkbox checked={amend} onCheckedChange={(value) => toggleAmend(value === true)} disabled={busy || lastCommit === null} aria-label="Amend" />
            Amend
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={signoff} onCheckedChange={(value) => setSignoff(value === true)} disabled={busy} aria-label="Sign-off" />
            Sign-off
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox checked={runHooks} onCheckedChange={(value) => setRunHooks(value === true)} disabled={busy} aria-label="Run Git hooks" />
            Run Git hooks
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!canCommit} data-testid="vcs-commit-button">
            {amend ? "Amend" : "Commit"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!canPush} onClick={() => submit(true)} data-testid="vcs-commit-push-button">
            {amend ? "Amend and Push" : "Commit and Push"}
          </Button>
          {AGENT_ACTION_VARIANTS.map((variant) => {
            const action = AGENT_ACTIONS[variant];
            // Runs no git: it sends `action.message` to this thread as if the
            // human had typed it. The Sent icon is the host's own glyph for a
            // queued message, which is what `queue-if-active` makes this.
            const explains = `Sends “${action.message}” to this thread's agent, as if you had typed it. Runs no git here.`;
            // The title sits on a wrapper because the vendored Button drops
            // `title` from its props; hovering the button still shows it, and
            // a re-vendored Button cannot silently take it away again.
            return (
              <span key={variant} title={explains} className="inline-flex">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  aria-label={`${action.label}: ${explains}`}
                  disabled={sending}
                  onClick={() => void askAgent(variant)}
                  data-testid={`vcs-agent-${variant}-button`}
                >
                  <Icon name="Sent" className="size-3.5" aria-hidden />
                  {action.label}
                </Button>
              </span>
            );
          })}
          {progress !== null && busy ? (
            <Button type="button" size="sm" variant="outline" className="ml-auto h-7 px-2 text-xs" onClick={() => void jobs.cancel(progress.jobId)}>
              Cancel
            </Button>
          ) : null}
        </div>
        <div role="status" aria-live="polite" className="text-xs">
          {blocked !== null ? (
            <p className="text-muted-foreground">{blocked}</p>
          ) : changes?.ok && files.length > 0 && stagedCount === 0 && !amend ? (
            <p className="text-muted-foreground">Nothing is staged: tick the files to include.</p>
          ) : null}
          {changes?.ok && changes.operation !== "none" && blocked === null ? (
            <p className="text-muted-foreground">A {changes.operation} is in progress; this commit concludes it.</p>
          ) : null}
          {status.kind === "busy" ? (
            <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="vcs-commit-busy">
              <Icon name="Loading" className="size-3 animate-spin" />
              <span className="min-w-0 flex-1 truncate">
                {status.text}
                {progress?.lastLine ? <span className="ml-2 font-mono text-[11px]">{progress.lastLine}</span> : null}
              </span>
            </p>
          ) : status.kind === "ok" ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Icon name="Check" className="size-3" />
              {status.text}
            </p>
          ) : status.kind === "error" ? (
            <div className="text-destructive">
              <p>{status.error.message}</p>
              {status.error.hint ? <p className="text-muted-foreground">{status.error.hint}</p> : null}
              {status.error.stderr ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">Details</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] text-foreground">{status.error.stderr}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          {notice !== null ? (
            <p className={cn("flex items-center gap-1.5", notice.kind === "error" ? "text-destructive" : "text-muted-foreground")} data-testid="vcs-commit-notice">
              {notice.kind === "ok" ? <Icon name="Check" className="size-3 shrink-0" /> : null}
              <span className="min-w-0 flex-1">{notice.text}</span>
            </p>
          ) : null}
        </div>
      </form>
      <ConfirmStep request={actions.confirm} onCancel={actions.cancelConfirm} onConfirm={actions.acceptConfirm} />
    </div>
  );
}
