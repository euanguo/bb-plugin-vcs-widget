import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import type { LocalBranch, Overview, TagList } from "../contracts";
import type { JobProgress } from "../hooks/use-jobs";
import { usePopupList } from "../hooks/use-popup-list";
import type { ActionStatus } from "../hooks/use-vcs-actions";
import {
  blockingReason,
  groupBranches,
  quickActionsFor,
  type BranchEntry,
  type BranchMenuItemId,
  type QuickActionId,
} from "../shared/model";
import { buildPopupRows, popupSource } from "../shared/popup-rows";
import { BranchListRows } from "./BranchList";
import type { MenuExtra } from "./BranchRow";
import { NewBranchStep } from "./NewBranchStep";
import { RenameStep } from "./RenameStep";
import { RevisionStep } from "./RevisionStep";
import { StatusLine } from "./StatusLine";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";

type Step =
  | { kind: "list" }
  | { kind: "new-branch"; from: string | null }
  | { kind: "rename"; branch: LocalBranch }
  | { kind: "revision" };

interface BranchPopupProps {
  open: boolean;
  overview: Overview | null;
  loading: boolean;
  loadError: string | null;
  status: ActionStatus;
  busy: boolean;
  favourites: ReadonlySet<string>;
  jobProgress: JobProgress | null;
  /** A quick action requested from the command palette, run once ready. */
  pendingAction: QuickActionId | null;
  onPendingActionConsumed: () => void;
  onCheckout: (entry: BranchEntry) => void;
  onCreateBranch: (input: { name: string; startPoint: string | null; checkout: boolean }) => void;
  onRename: (branch: LocalBranch, to: string) => void;
  onCheckoutRevision: (revision: string) => void;
  onQuickAction: (id: QuickActionId) => void;
  /** Menu rows the popup does not handle itself. */
  onMenu: (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => void;
  onToggleFavourite: (entry: BranchEntry) => void;
  onCancelJob: (jobId: string) => void;
  onAbort: () => void;
  loadTags: () => Promise<TagList>;
}

export function BranchPopup({
  open,
  overview,
  loading,
  loadError,
  status,
  busy,
  favourites,
  jobProgress,
  pendingAction,
  onPendingActionConsumed,
  onCheckout,
  onCreateBranch,
  onRename,
  onCheckoutRevision,
  onQuickAction,
  onMenu,
  onToggleFavourite,
  onCancelJob,
  onAbort,
  loadTags,
}: BranchPopupProps) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const inputRef = useRef<HTMLInputElement>(null);

  // The popup stays mounted while closed; a reopen starts from a clean list.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setStep({ kind: "list" });
    }
  }, [open]);

  const groups = useMemo(() => (overview ? groupBranches(overview, favourites) : null), [overview, favourites]);
  // Two steps on purpose: `popupSource` makes the `BranchEntry` objects once
  // per repository read, and `buildPopupRows` filters and ranks them once per
  // keystroke. Typing therefore hands every surviving row the same entry it
  // had, which is what lets its memo hold.
  const source = useMemo(() => popupSource(overview, groups), [overview, groups]);
  const rows = useMemo(() => buildPopupRows(source, query, favourites), [source, query, favourites]);
  const list = usePopupList(rows, query);
  const unavailable = overview?.unavailableReason ?? null;
  const rowDisabled = busy || unavailable !== null;

  // Every handler a row is given has to keep its identity across renders, or
  // the row's memo is worthless and the list re-renders whole on each
  // keystroke. They read the latest props through a ref — the pattern the
  // continuous diff stream uses for the same reason — so a row built once
  // stays built.
  const latest = useRef({ overview, busy, unavailable, onCheckout, onQuickAction, onMenu, onToggleFavourite, rowDisabled });
  latest.current = { overview, busy, unavailable, onCheckout, onQuickAction, onMenu, onToggleFavourite, rowDisabled };

  const runQuickAction = useCallback((id: QuickActionId) => {
    if (id === "new-branch") {
      setStep({ kind: "new-branch", from: null });
      return;
    }
    if (id === "checkout-revision") {
      setStep({ kind: "revision" });
      return;
    }
    latest.current.onQuickAction(id);
  }, []);

  // A palette request obeys the same guards as a click on the row.
  useEffect(() => {
    if (pendingAction === null || overview === null) return;
    onPendingActionConsumed();
    const action = quickActionsFor(overview).find((candidate) => candidate.id === pendingAction);
    if (action === undefined || action.disabled || busy) {
      toast.error(action?.reason ?? "Another VCS action is still running.");
      return;
    }
    runQuickAction(pendingAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per request
  }, [pendingAction, overview]);

  const handleMenu = useCallback((itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => {
    switch (itemId) {
      case "checkout":
        latest.current.onCheckout(entry);
        return;
      case "new-branch-from":
        setStep({ kind: "new-branch", from: entry.branch.name });
        return;
      case "rename":
        if (entry.kind === "local") setStep({ kind: "rename", branch: entry.branch });
        return;
      case "favourite":
        latest.current.onToggleFavourite(entry);
        return;
      case "copy-name":
        void navigator.clipboard?.writeText(entry.branch.name).then(
          () => toast.success(`Copied ${entry.branch.name}`),
          () => toast.error("Could not copy the branch name."),
        );
        return;
      default:
        latest.current.onMenu(itemId, entry, extra);
    }
  }, []);

  // F2 renames the highlighted local branch, as in IntelliJ.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const view = latest.current.overview;
    if (event.key !== "F2" || view === null) return;
    const selected = list.listElement?.querySelector('[cmdk-item][data-selected="true"][data-branch-kind="local"]');
    const name = selected?.getAttribute("data-branch-name");
    const branch = name ? view.local.find((candidate) => candidate.name === name) : undefined;
    if (branch === undefined) return;
    event.preventDefault();
    setStep({ kind: "rename", branch });
  };

  const back = () => setStep({ kind: "list" });
  // A disabled cmdk row loses its context menu (pointer-events), so a row
  // stays clickable while an operation or job blocks the repository and
  // Enter/click explain instead of running.
  const selectRow = useCallback((entry: BranchEntry) => {
    const view = latest.current.overview;
    const reason = view === null ? null : blockingReason(view);
    if (reason !== null) {
      toast.error(reason);
      return;
    }
    latest.current.onCheckout(entry);
  }, []);

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="w-[28rem] max-w-[calc(100vw-1rem)] p-0"
      mobileTitle="Git branches"
      autoFocusRef={inputRef}
      data-testid="vcs-branch-popup"
      onEscapeKeyDown={(event) => {
        // Radix dismisses on Escape at the document level before any input
        // handler runs; in a form step Escape goes back to the list.
        if (step.kind !== "list") {
          event.preventDefault();
          back();
        }
      }}
    >
      {step.kind === "new-branch" ? (
        <NewBranchStep
          from={step.from}
          busy={busy}
          onCancel={back}
          onCreate={({ name, checkout }) => {
            onCreateBranch({ name, startPoint: step.from, checkout });
            back();
          }}
        />
      ) : step.kind === "rename" ? (
        <RenameStep
          from={step.branch.name}
          busy={busy}
          onCancel={back}
          onRename={(to) => {
            onRename(step.branch, to);
            back();
          }}
        />
      ) : step.kind === "revision" ? (
        <RevisionStep
          busy={busy}
          loadTags={loadTags}
          onCancel={back}
          onCheckout={(revision) => {
            onCheckoutRevision(revision);
            back();
          }}
        />
      ) : (
        // cmdk's own handler runs after this one and skips itself whenever the
        // event was default-prevented, which is how the window keeps the two
        // keys it has to correct without taking the keyboard over.
        <Command
          shouldFilter={false}
          loop
          className="rounded-md"
          onKeyDown={(event) => {
            list.onKeyDown(event);
            onListKeyDown(event);
          }}
        >
          <CommandInput
            ref={inputRef}
            placeholder="Search for branches and actions"
            aria-label="Search for branches and actions"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList ref={list.listRef} onScroll={list.onScroll} className="max-h-[min(60vh,28rem)]">
            {unavailable !== null ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{unavailable}</p>
            ) : (
              <>
                <CommandEmpty>
                  {overview === null ? "Reading repository…" : `Nothing matches “${query}”.`}
                </CommandEmpty>
                {overview !== null ? (
                  <BranchListRows
                    rows={rows}
                    window={list.window}
                    overview={overview}
                    disabled={rowDisabled}
                    favourites={favourites}
                    onSelect={selectRow}
                    onMenu={handleMenu}
                    onAction={runQuickAction}
                  />
                ) : null}
              </>
            )}
          </CommandList>
          <StatusLine
            status={status}
            overview={overview}
            loading={loading}
            loadError={loadError}
            jobProgress={jobProgress}
            onCancelJob={onCancelJob}
            onAbort={onAbort}
          />
        </Command>
      )}
    </PopoverContent>
  );
}
