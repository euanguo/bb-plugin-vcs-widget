// The commit dialog as a thread panel tab: the working tree and the index
// as a checklist (the checkbox is the staged state), bb's diff viewer for
// the selected file, the message, and Commit / Commit and Push. Every
// mutation goes through useVcsActions, so discards and amends ask first with
// the exact command and the commit runs as a job on the host.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ChangeEntry, Commit, DiffTarget, FileDiff } from "../contracts";
import { useChanges } from "../hooks/use-changes";
import { useDiffPatches, type PatchRequest } from "../hooks/use-diff-patches";
import { useDiffContents } from "../hooks/use-diff-contents";
import { useDiffTarget } from "../hooks/use-diff-target";
import { usePersistedState } from "../hooks/use-persisted-state";
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
import { ChangeTree, INDENT_BASE, INDENT_STEP } from "./ChangeTree";
import { ChangeFileRow } from "./ChangeFileRow";
import { FileStats } from "./FileStats";
import { statusLetterClass } from "./status-letter";
import { DiffWrapToggle, useDiffWrap } from "./DiffWrapToggle";
import { ContinuousDiffStream, streamRowKey, type DiffStreamEntry } from "./ContinuousDiffStream";
import { TargetPicker } from "./TargetPicker";
import {
  baseCandidates,
  compareRefKey,
  defaultBase,
  parseCompareRef,
  targetLabel,
  UNCOMMITTED,
  type PanelTarget,
} from "../shared/target";
import { RepositoryEmptyState } from "./RepositoryEmptyState";
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
import { Icon } from "@bb/shared-ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface PanelProps {
  threadId: string;
  params: unknown;
}

/** The tag a working-tree row wears; a target's rows wear none. */
const SIDE_TAG: Record<DiffSide, string> = { index: "Staged", worktree: "Unstaged" };

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
  /** A committed file: nothing to stage and nothing to discard. */
  readOnly: boolean;
  disabled: boolean;
  pending: boolean;
  onToggle: (entry: ChangeEntry) => void;
  onSelect: (entry: ChangeEntry) => void;
  onDiscard: (entry: ChangeEntry) => void;
  onMenu: (itemId: FileMenuItemId, entry: ChangeEntry) => void;
}

/**
 * A row in the flat and by-status lists. The tree draws the same row through
 * the same component, so the two lists cannot drift apart again.
 */
function Row({ entry, selected, readOnly, disabled, pending, onToggle, onSelect, onDiscard, onMenu }: RowProps) {
  return (
    <ChangeFileRow
      entry={entry}
      label={
        entry.oldPath ? (
          <>
            <span className="text-muted-foreground">{entry.oldPath} → </span>
            {entry.path}
          </>
        ) : (
          entry.path
        )
      }
      depth={null}
      selected={selected}
      readOnly={readOnly}
      disabled={disabled}
      pending={pending}
      onToggle={onToggle}
      onSelect={onSelect}
      onDiscard={onDiscard}
      onMenu={onMenu}
    />
  );
}

interface GroupProps {
  title: string;
  /** Directory depth, so a nested group indents its header. */
  depth: number;
  entries: ChangeEntry[];
  selected: string | null;
  /** Committed files: the header's tick and its discard-all are left out. */
  readOnly: boolean;
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

function Group({ title, depth, entries, selected, readOnly, disabled, pendingPaths, onToggleAll, onToggle, onSelect, onDiscard, onMenu, onDiscardAll }: GroupProps) {
  if (entries.length === 0) return null;
  const allStaged = entries.every((entry) => stageState(entry) === "staged");
  const noneStaged = entries.every((entry) => stageState(entry) === "unstaged");
  const allUntracked = entries.every((entry) => entry.kind === "untracked");
  return (
    <section aria-label={title}>
      <header
        className="group/header flex items-center gap-2 py-1 pr-2 text-[11px] font-medium text-muted-foreground"
        style={{ paddingLeft: `${INDENT_BASE + depth * INDENT_STEP}px` }}
      >
        <span>{title}</span>
        <span className="tabular-nums">({entries.length})</span>
        <span className="ml-auto flex items-center gap-2">
          {readOnly || onDiscardAll === null ? null : (
            <button
              type="button"
              aria-label={`Discard all changes in ${title}`}
              title={allUntracked ? "Delete every file git does not track here" : "Revert every file here to HEAD"}
              disabled={disabled}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-0 group-hover/header:opacity-100"
              onClick={() => onDiscardAll(entries)}
            >
              <Icon name="RotateCcw" className="size-3.5" />
            </button>
          )}
          {readOnly ? null : (
            <Checkbox
              checked={allStaged ? true : noneStaged ? false : "indeterminate"}
              aria-label={allStaged ? `Unstage all in ${title}` : `Stage all in ${title}`}
              disabled={disabled}
              onCheckedChange={() => onToggleAll(entries, !allStaged)}
            />
          )}
        </span>
      </header>
      <ul>
        {entries.map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            selected={selected === entry.path}
            readOnly={readOnly}
            disabled={disabled}
            pending={pendingPaths.has(entry.path)}
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
  // A file-list click scrolls the stream to that file rather than swapping
  // what the pane shows; the request is cleared once it has been honoured.
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  // Which paths have a stage/unstage in flight. The list disables only those
  // rows, not every row: a global `busy` turned the whole list half-opaque
  // for the length of one round trip, which is the flicker this fixes.
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [isResizing, setIsResizing] = useState(false);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [signoff, setSignoff] = useState(false);
  const [runHooks, setRunHooks] = useState(true);
  const [grouping, setGrouping] = usePersistedState<GroupingMode>(`vcs-widget.grouping.${threadId}`, "directory");
  const [heaviestFirst, setHeaviestFirst] = usePersistedState(`vcs-widget.grouping-heavy.${threadId}`, false);
  const [collapsedTreePaths, setCollapsedTreePaths] = usePersistedState<string[]>(`vcs-widget.tree-collapsed.${threadId}`, []);
  const [rightPaneWidth, setRightPaneWidth] = usePersistedState(`vcs-widget.right-pane-width.${threadId}`, 320);
  // What the diff pane is pointed at, and how it is rendered. The target is
  // not persisted: a sha stops meaning anything after a rebase, and reopening
  // a commit panel to find it showing last week's commit is worse than
  // reopening it on the working tree.
  const [target, setTarget] = useState<PanelTarget>(UNCOMMITTED);
  const [baseKey, setBaseKey] = usePersistedState<string>(`vcs-widget.diff-base.${threadId}`, "");
  const [wrap, setWrap] = useDiffWrap(threadId);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const prefilled = useRef<string | null>(null);
  const changesUpdatedAt = changes;

  const handleToggleTreePath = useCallback((path: string) => {
    setCollapsedTreePaths((current) => current.includes(path) ? current.filter((value) => value !== path) : [...current, path]);
  }, [setCollapsedTreePaths]);
  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (event: PointerEvent) => {
      const bounds = splitRef.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      const next = Math.min(520, Math.max(220, bounds.right - event.clientX));
      setRightPaneWidth(next);
    };
    const handleUp = () => setIsResizing(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [isResizing, setRightPaneWidth]);
  // What the working tree holds, whatever the diff pane is pointed at: the
  // commit form below always commits the index, so its counts and its staged
  // state are never the target's.
  const worktreeFiles = useMemo(() => (changes?.ok ? changes.files : []), [changes]);
  const groups = useMemo(() => {
    const grouped = groupChanges(worktreeFiles, grouping);
    return heaviestFirst ? sortGroupsByWeight(grouped) : grouped;
  }, [worktreeFiles, grouping, heaviestFirst]);
  const collapsedTreePathSet = useMemo(() => new Set(collapsedTreePaths), [collapsedTreePaths]);
  const stagedCount = worktreeFiles.filter(isStaged).length;

  // The diff pane's target. A range needs a base to be measured from, so the
  // stored one is used when it still parses and the repository's own idea of
  // "the branch this lands on" is used otherwise.
  const bases = useMemo(() => baseCandidates(overview), [overview]);
  const storedBase = useMemo(() => parseCompareRef(baseKey), [baseKey]);
  // Memoized: `defaultBase` builds a fresh object, and a base that changed
  // identity on every render would re-read the target on every render.
  const base = useMemo(() => storedBase ?? defaultBase(overview), [storedBase, overview]);
  // A range with no branch to measure from is the working tree; anything else
  // would be a read the host cannot answer.
  const activeTarget = target.kind === "commits" && base === null ? UNCOMMITTED : target;
  const diffTarget = useMemo<DiffTarget | null>(() => {
    if (activeTarget.kind === "uncommitted") return null;
    if (activeTarget.kind === "commit") return { kind: "commit", sha: activeTarget.sha };
    return base === null ? null : { kind: "commits", base };
  }, [activeTarget, base]);
  const targetRead = useDiffTarget(threadId, diffTarget, changes);
  const files = diffTarget === null ? worktreeFiles : targetRead.files;

  // The commit list the picker offers, held with the base it describes.
  //
  // A range read returns the list; a single-commit read does not, and the
  // reader who picked one commit is still standing in the list they picked it
  // from, so the list is kept rather than dropping to a bare sha the moment one
  // is chosen. What it is not allowed to survive is a change of base: the same
  // list against another branch names commits that branch's range does not
  // hold, and offering them is worse than offering none.
  const [knownCommits, setKnownCommits] = useState<{ base: string; commits: Commit[] }>({ base: "", commits: [] });
  const commitsBase = base === null ? "" : compareRefKey(base);
  useEffect(() => {
    // Only a range answers with a list, and only a landed read may replace one:
    // an in-flight or failed read is not an empty range.
    if (activeTarget.kind !== "commits" || commitsBase === "") return;
    if (targetRead.loading || targetRead.error !== null) return;
    setKnownCommits((previous) =>
      previous.base === commitsBase && previous.commits === targetRead.commits
        ? previous
        : { base: commitsBase, commits: targetRead.commits },
    );
  }, [activeTarget.kind, commitsBase, targetRead.loading, targetRead.error, targetRead.commits]);
  const commits = knownCommits.base === commitsBase ? knownCommits.commits : [];
  // Both sides go into the one stream, staged first: a file that is staged and
  // then edited again shows both of its changes, and nothing needs a mode
  // switch to be seen. A batch read names exactly one side, so each side keeps
  // its own reader and a page stays one host call.
  //
  // A commit or a range has no second side, so it is one row per file on one
  // channel. The two index readers stay mounted either way -- hooks cannot be
  // conditional -- but a target's reader is null, which is how the hook is
  // told to fetch nothing.
  const streamEntries = useMemo<DiffStreamEntry[]>(() => {
    if (diffTarget !== null) return targetRead.files.map((entry) => ({ entry, channel: "target" as const, tag: null }));
    return worktreeFiles.flatMap((entry) =>
      diffSidesFor(entry).map((side) => ({ entry, channel: side, tag: SIDE_TAG[side] })),
    );
  }, [diffTarget, targetRead.files, worktreeFiles]);
  const indexRequest = useMemo<PatchRequest>(() => ({ kind: "side", side: "index" }), []);
  const worktreeRequest = useMemo<PatchRequest>(() => ({ kind: "side", side: "worktree" }), []);
  const targetRequest = useMemo<PatchRequest | null>(
    () => (diffTarget === null ? null : { kind: "target", target: diffTarget }),
    [diffTarget],
  );
  // The two index readers are off while a target is in view: nothing on screen
  // would render their patches, and reading them anyway costs a host call per
  // page of files nobody asked for.
  const indexPatches = useDiffPatches(threadId, indexRequest, diffTarget === null);
  const worktreePatches = useDiffPatches(threadId, worktreeRequest, diffTarget === null);
  const targetPatches = useDiffPatches(threadId, targetRequest, true);
  const patches = useMemo(
    () => ({ index: indexPatches, worktree: worktreePatches, target: targetPatches }),
    [indexPatches, worktreePatches, targetPatches],
  );
  const indexContents = useDiffContents(threadId, "index", diffTarget === null);
  const worktreeContents = useDiffContents(threadId, "worktree", diffTarget === null);
  // A commit's two complete sides are not readable through `diffFile`, which
  // names a side of the index; the target's reader is therefore off, and those
  // cards simply do not offer "expand unchanged lines".
  const targetContents = useDiffContents(threadId, "worktree", false);
  const contents = useMemo(
    () => ({ index: indexContents, worktree: worktreeContents, target: targetContents }),
    [indexContents, worktreeContents, targetContents],
  );

  // Folding lives here rather than inside the stream so the control that
  // folds every row can sit in the pane's own header, beside what to diff.
  const [collapsedRows, setCollapsedRows] = useState<ReadonlySet<string>>(() => new Set());
  const streamKeys = useMemo(() => streamEntries.map(streamRowKey), [streamEntries]);
  const allStreamCollapsed = streamKeys.length > 0 && streamKeys.every((key) => collapsedRows.has(key));
  const toggleStreamRow = useCallback((key: string) => {
    setCollapsedRows((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleAllStream = useCallback(() => {
    setCollapsedRows((previous) => {
      const every = streamKeys.length > 0 && streamKeys.every((key) => previous.has(key));
      return every ? new Set<string>() : new Set(streamKeys);
    });
  }, [streamKeys]);

  /** The `+N -M` the whole view adds up to, or null when nothing was counted. */
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let known = false;
    for (const entry of files) {
      if (entry.additions !== null) {
        additions += entry.additions;
        known = true;
      }
      if (entry.deletions !== null) {
        deletions += entry.deletions;
        known = true;
      }
    }
    return known ? { additions, deletions } : null;
  }, [files]);

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

  // No repository: the diff pane and the file list would each only have an
  // error to show, so the panel shows one empty state instead of both.
  if (overview !== null && overview.unavailableReason !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col text-sm" data-testid="vcs-commit-panel">
        <RepositoryEmptyState
          kind={overview.unavailableKind}
          reason={overview.unavailableReason ?? ""}
          onRetry={refetch}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-sm" data-testid="vcs-commit-panel">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="Check" className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Commit</span>
        <span className="min-w-0 truncate text-muted-foreground" data-testid="vcs-commit-branch">
          {label}
        </span>
        <span className="ml-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground" data-testid="vcs-commit-counts">
          {changes?.ok ? `${stagedCount} staged · ${worktreeFiles.length - stagedCount} unstaged` : ""}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0" aria-label="Refresh" onClick={refetch} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </header>

      {/* Left: every changed file's diff, stacked. Right: the file list. */}
      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            The row above the diffs used to carry a sentence saying what the
            stream already shows. It carries the two controls that change what
            is in it instead: what to diff, and whether a long line wraps.
          */}
          <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1">
            <TargetPicker
              target={activeTarget}
              base={base}
              bases={bases}
              commits={commits}
              onSelectTarget={setTarget}
              onSelectBase={(next) => setBaseKey(compareRefKey(next))}
            />
            <span className="shrink-0 font-mono text-[11px] tabular-nums" data-testid="vcs-diff-totals">
              {totals === null ? null : (
                <>
                  <span className="text-diff-added">+{totals.additions}</span>
                  <span className="ml-1 text-diff-removed">-{totals.deletions}</span>
                </>
              )}
            </span>
            <DiffWrapToggle wrap={wrap} onToggle={() => setWrap((value) => !value)} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0"
              aria-label={allStreamCollapsed ? "Expand every diff" : "Collapse every diff"}
              onClick={toggleAllStream}
              data-testid="vcs-stream-toggle-all"
            >
              <Icon name={allStreamCollapsed ? "ChevronsDown" : "ChevronsUp"} className="size-3.5" />
            </Button>
          </div>
          <ContinuousDiffStream
            threadId={threadId}
            entries={streamEntries}
            patches={patches}
            contents={contents}
            wrap={wrap}
            filesUpdatedAt={changesUpdatedAt}
            isPanelOpen
            scrollToPath={scrollToPath}
            onScrolledToPath={() => setScrollToPath(null)}
            collapsed={collapsedRows}
            onToggleCollapsed={toggleStreamRow}
            onOpenFile={undefined}
          />
        </div>

        {/*
          The seam bb's own panels draw between two panes: a hairline that
          takes the ring colour under the pointer, with a much wider invisible
          target around it. A one-pixel line is what the eye wants and is
          nowhere near what a hand can hit.
        */}
        <button
          type="button"
          className={cn(
            "relative w-px shrink-0 cursor-col-resize border-0 bg-border-seam p-0 transition-colors hover:bg-ring/40",
            isResizing && "bg-ring/40",
          )}
          aria-label="Resize changed files panel"
          onPointerDown={(event) => {
            event.preventDefault();
            setIsResizing(true);
          }}
          data-testid="vcs-file-list-resizer"
        >
          <span aria-hidden className="absolute -left-1.5 top-0 h-full w-3" />
        </button>
        <div
          className="flex min-h-0 min-w-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto"
          style={{ width: rightPaneWidth }}
          aria-label="Changed files"
          data-testid="vcs-file-list"
        >
          {error !== null ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : diffTarget !== null && targetRead.error !== null ? (
            // A target read that failed says why, rather than looking like a
            // range with nothing in it.
            <p className="p-4 text-sm text-destructive" data-testid="vcs-target-error">
              {targetRead.error}
            </p>
          ) : diffTarget !== null && targetRead.loading && files.length === 0 ? (
            <Empty>{`Reading ${targetLabel(activeTarget, base, commits)}…`}</Empty>
          ) : changes === null ? (
            <Empty>Reading the working tree…</Empty>
          ) : !changes.ok ? (
            <p className="p-4 text-sm text-destructive">{changes.error.message}</p>
          ) : files.length === 0 ? (
            <Empty>
              {diffTarget === null ? "Nothing to commit: the working tree is clean." : "No file differs in this view."}
            </Empty>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1">
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
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground" data-testid="vcs-file-count">
                  {files.length}
                </span>
              </div>
              {grouping === "directory" ? (
                <ChangeTree
                  entries={files}
                  selected={selected}
                  readOnly={diffTarget !== null}
                  collapsedPaths={collapsedTreePathSet}
                  disabled={disabled}
                  pendingPaths={pendingPaths}
                  onToggleDirectory={handleToggleTreePath}
                  onToggleAll={toggleAll}
                  onToggleFile={toggle}
                  onSelectFile={(next) => {
                    setSelected(next.path);
                    setScrollToPath(next.path);
                  }}
                  onDiscardFile={discardOne}
                  onMenu={onFileMenu}
                />
              ) : groups.map((group) => (
                <Group
                  key={group.key}
                  title={group.title}
                  depth={group.depth}
                  entries={group.entries}
                  selected={selected}
                  readOnly={diffTarget !== null}
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
              {diffTarget === null && changes.truncated ? <p className="px-2 py-1 text-xs text-muted-foreground">Only the first {files.length} files are listed.</p> : null}
              {targetRead.truncated ? <p className="px-2 py-1 text-xs text-muted-foreground">Only the first {files.length} files are listed.</p> : null}
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
