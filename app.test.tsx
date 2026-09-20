// @vitest-environment jsdom
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The panel persists view preferences (grouping, tree folding, split width)
  // per thread; without this they leak from one test into the next.
  window.localStorage.clear();
  // The overview's freshness window is module scope, so it outlives the
  // unmount that `cleanup` does.
  clearOverviewCache();
});

/**
 * Moves the wall clock forward without stopping it: the popup dates a retained
 * outcome from `Date.now()`, and fake timers do not mix with user-event.
 */
function advanceClock(ms: number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + ms);
}
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { ActionResult, ChangesResult, JobStart, LogCommit, Overview } from "./contracts";
import type { JobKind } from "./shared/constants";
import { CHANGE_LIST_ROW_HEIGHT, CHANGE_LIST_WINDOW_OVERSCAN, DIFF_WRAP_PIN_SETTLE_MS, PANE_WIDTH, PATCH_ROOT_MARGIN, POPUP_ROW_HEIGHT, POPUP_WINDOW_OVERSCAN } from "./shared/constants";
import { unavailableOverview } from "./contracts";
import { requestOpen } from "./lib/events";
import { clearOverviewCache } from "./shared/overview-cache";
import type { rpcContract } from "./server";

// jsdom lacks the layout APIs Radix and cmdk touch.
beforeAll(() => {
  // nwsapi implements ':modal' by re-entering Element.matches until it
  // overflows the stack (~300 ms per call); floating-ui asks for it on every
  // ancestor while Radix positions the popover, which cost 25 s per open.
  const nativeMatches = Element.prototype.matches;
  Element.prototype.matches = function matches(this: Element, selector: string) {
    if (selector === ":modal" || selector === ":popover-open" || selector === ":fullscreen") return false;
    return nativeMatches.call(this, selector);
  };
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

function overview(extra: Partial<Overview> = {}): Overview {
  const branch = (name: string, isCurrent = false) => ({
    name,
    sha: "abc1234",
    upstream: isCurrent ? "origin/main" : null,
    ahead: 0,
    behind: 0,
    gone: false,
    isCurrent,
    worktreePath: null,
    committedAt: 1,
    subject: "",
  });
  return {
    ...unavailableOverview(""),
    unavailableReason: null,
    unavailableKind: null,
    repoRoot: "/repo",
    repoName: "repo",
    gitVersion: "2.55.0",
    head: { kind: "branch", name: "main", sha: "abc1234" },
    upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 0, behind: 0, gone: false },
    remotes: ["origin"],
    local: [branch("main", true), branch("feature"), branch("release")],
    remote: [
      { name: "origin/main", remote: "origin", branch: "main", sha: "abc1234", hasLocal: true, committedAt: 1, subject: "" },
      { name: "origin/hotfix", remote: "origin", branch: "hotfix", sha: "abc1234", hasLocal: false, committedAt: 1, subject: "" },
    ],
    recent: ["feature"],
    ...extra,
  };
}

const sidebarThread = (environment: { id: string; branchName: string } | null) => ({
  status: "ready" as const,
  projects: [],
  threads: [
    {
      id: "t1",
      projectId: "p1",
      title: "Thread",
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "claude-code",
      hasPendingInteraction: false,
      activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
      indicator: "none" as const,
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: environment
        ? { id: environment.id, name: "repo", branchName: environment.branchName, providerId: null, workspaceDisplayKind: "other" as const }
        : null,
      host: { id: "h1", name: "laptop" },
      createdAt: 0,
      updatedAt: 0,
      lastReadAt: null,
      latestAttentionAt: 0,
    },
  ],
});

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("./app"));
});

const props = { threadId: "t1", projectId: "p1", isCompactViewport: false };

const job = (kind: JobKind, jobId = `job-${kind}`): JobStart => ({
  ok: true,
  jobId,
  kind,
  command: `git ${kind}`,
  startedAt: 1,
});

type Rpc = NonNullable<Parameters<typeof renderSlot<typeof props, typeof rpcContract>>[2]>["rpc"];

function render(options: {
  overview?: Overview;
  checkout?: (input: unknown) => ActionResult;
  environment?: { id: string; branchName: string } | null;
  compact?: boolean;
  /** The thread is hidden or archived: absent from bb's sidebar list. */
  offSidebar?: boolean;
  rpc?: Partial<NonNullable<Rpc>>;
  favourites?: string[];
  openThreadPanel?: (options: { actionId: string; title?: string; params?: unknown }) => boolean;
} = {}) {
  const view = options.overview ?? overview();
  const sidebar = sidebarThread(options.environment === undefined ? { id: "env1", branchName: "main" } : options.environment);
  let favourites = options.favourites ?? [];
  return renderSlot<typeof props, typeof rpcContract>(
    app.threadHeaderActions[0]!,
    { ...props, isCompactViewport: options.compact ?? false },
    {
      sidebarThreads: options.offSidebar ? { ...sidebar, threads: [] } : sidebar,
      settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
      openThreadPanel: options.openThreadPanel ?? (() => true),
      rpc: {
        overview: () => view,
        checkout: (input) =>
          options.checkout?.(input) ?? {
            ok: true,
            message: `Switched to ${input.target.kind === "local" ? input.target.name : input.target.branch}.`,
            overview: view,
          },
        createBranch: () => ({ ok: true, message: "Created.", overview: view }),
        fetch: () => job("fetch"),
        pull: () => job("pull"),
        push: () => job("push"),
        updateBranch: () => job("updateBranch"),
        deleteRemoteBranch: () => job("deleteRemoteBranch"),
        jobGet: () => null,
        jobCancel: () => ({ cancelled: true }),
        deleteBranch: (input) => ({ ok: true, message: `Deleted ${input.name}.`, overview: view }),
        renameBranch: (input) => ({ ok: true, message: `Renamed ${input.from} to ${input.to}.`, overview: view }),
        merge: () => ({ ok: true, message: "Merged.", overview: view }),
        rebase: () => ({ ok: true, message: "Rebased.", overview: view }),
        abortOperation: () => ({ ok: true, message: "Aborted the rebase.", overview: { ...view, operation: "none" } }),
        setUpstream: () => ({ ok: true, message: "Tracking.", overview: view }),
        addWorktree: () => ({ ok: true, message: "Added worktree.", overview: view }),
        checkoutRevision: (input) => ({ ok: true, message: `Checked out ${input.revision}.`, overview: view }),
        listTags: () => ({ ok: true, tags: [{ name: "v1.0", sha: "abc1234", createdAt: 1, subject: "one" }], truncated: false }),
        compare: () => ({ ok: true, base: "main", target: "feature", aheadCount: 1, behindCount: 0, ahead: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", author: "Costa", committedAt: 1, subject: "feature work" }], behind: [], files: [{ path: "a.txt", oldPath: null, additions: 1, deletions: 0, binary: false }], truncated: { ahead: false, behind: false, files: false } }),
        comparePatch: (input) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
        diffWorkingTree: () => ({ ok: true, ref: "main", files: [], truncated: false }),
        diffWorkingTreePatch: (input) => ({ ok: true, path: input.path, patch: "", truncated: false, binary: false, contents: null }),
        favourites: () => ({ names: favourites }),
        setFavourite: (input) => {
          favourites = input.favourite ? [...favourites, input.name] : favourites.filter((name) => name !== input.name);
          return { names: favourites };
        },
        favouriteRepos: () => ({ repos: [] }),
        clearFavourites: () => ({ repos: [] }),
        changes: () => CHANGES,
        diffFile: (input) => ({ ok: true, path: input.path, side: input.side, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: { old: { path: input.path, content: "a\n" }, new: { path: input.path, content: "b\n" } } }),
        diffFiles: (input) => ({
          ok: true,
          files: input.paths.map((path) => ({ path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false })),
        }),
        diffTargetPatches: (input) => ({
          ok: true,
          files: input.paths.map((path) => ({ path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false })),
        }),
        diffTarget: () => ({ ok: true, files: [], commits: [], truncated: false }),
        imagePreview: (input: { path: string; mimeType: string }) => ({ ok: true, path: input.path, mimeType: input.mimeType, old: null, new: null }),
        stage: (input) => ({ ok: true, message: `Staged ${input.paths.length} file(s).`, overview: view }),
        unstage: (input) => ({ ok: true, message: `Unstaged ${input.paths.length} file(s).`, overview: view }),
        discard: () => ({ ok: true, message: "Discarded.", overview: view }),
        commit: () => job("commit"),
        log: () => ({ ok: true, commits: [], skip: 0, hasMore: false }),
        commitDetails: () => ({ ok: false, error: { code: "ref_not_found", message: "gone" } }),
        commitPatch: (input) => ({ ok: true, path: input.path, patch: "", truncated: false, binary: false, contents: null }),
        cherryPick: () => ({ ok: true, message: "Cherry-picked.", overview: view }),
        revert: () => ({ ok: true, message: "Reverted.", overview: view }),
        resetTo: () => ({ ok: true, message: "Reset.", overview: view }),
        sendToAgent: () => ({ ok: true, delivery: "sent" }),
        ...options.rpc,
      },
    },
  );
}

const CHANGES: ChangesResult = {
  ok: true,
  head: { kind: "branch", name: "main", sha: "abc1234" },
  operation: "none",
  indexLocked: false,
  truncated: false,
  lastCommit: { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Last one", message: "Last one\n\nBody" },
  files: [
    { path: "staged.txt", oldPath: null, index: "M", worktree: ".", kind: "tracked", additions: 3, deletions: 1 },
    { path: "edited.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked", additions: 2, deletions: 0 },
    { path: "both.txt", oldPath: null, index: "M", worktree: "M", kind: "tracked", additions: 5, deletions: 4 },
    { path: "new.txt", oldPath: null, index: ".", worktree: "?", kind: "untracked", additions: 7, deletions: 0 },
  ],
};

/** RPC methods called so far, without the favourites read that every open makes. */
const methods = (slot: { inspection: { rpcCalls: { method: string }[] } }) =>
  slot.inspection.rpcCalls.map((call) => call.method).filter((method) => method !== "favourites");

/** Opens the context menu of a branch row and returns the menu. */
async function openMenu(popup: HTMLElement, name: string) {
  const row = popup.querySelector(`[data-branch-name="${name}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${name}`);
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  return screen.findByTestId("vcs-branch-menu");
}

describe("header registration", () => {
  it("registers one thread header action", () => {
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual(["branches"]);
  });
});

describe("BranchButton", () => {
  it("labels itself from the sidebar without calling the server", () => {
    const slot = render();
    const button = slot.getByTestId("vcs-branch-button");
    expect(button.textContent).toContain("main");
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("renders nothing for a thread without an environment", () => {
    const slot = render({ environment: null });
    expect(slot.queryByTestId("vcs-branch-button")).toBeNull();
  });

  it("collapses to an icon on compact viewports", () => {
    const slot = render({ compact: true });
    const button = slot.getByTestId("vcs-branch-button");
    expect(button.getAttribute("aria-label")).toMatch(/^Git branch: main/u);
    expect(button.textContent).toBe("");
  });

  it("opens the popup, lists branches, filters and checks out", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    // "feature" is listed under Recent and Local.
    expect(await within(popup).findAllByText("feature")).toHaveLength(2);
    expect(within(popup).getByText("Recent")).toBeTruthy();
    expect(within(popup).getByText("Local")).toBeTruthy();
    expect(within(popup).getByText("Remote")).toBeTruthy();
    expect(within(popup).getByText("Update Project")).toBeTruthy();

    const input = within(popup).getByLabelText("Search for branches and actions");
    await user.type(input, "hot");
    await waitFor(() => expect(within(popup).queryByText("release")).toBeNull());
    expect(within(popup).getByText("origin/hotfix")).toBeTruthy();

    await user.click(within(popup).getByText("origin/hotfix"));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "checkout",
        input: { threadId: "t1", target: { kind: "remote", remote: "origin", branch: "hotfix" } },
      }),
    );
  });

  it("shows a typed failure in the status line and keeps the popup open", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({
        ok: false,
        error: { code: "dirty_worktree", message: "Checkout failed: local changes would be overwritten.", hint: "Commit or stash your changes first." },
        overview: overview(),
      }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("Checkout failed: local changes would be overwritten.");
    expect(within(popup).getByText("Commit or stash your changes first.")).toBeTruthy();
    expect(screen.queryByTestId("vcs-branch-popup")).not.toBeNull();
  });

  it("refetches on a realtime change for its environment and ignores others", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    await slot.behavior.emitRealtime("changed", { environmentId: "other", reason: "checkout" });
    expect(methods(slot)).toEqual(["overview"]);
    await slot.behavior.emitRealtime("changed", { environmentId: "env1", reason: "checkout" });
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "overview"]));
    await act(async () => {
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
    });
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "overview", "overview"]));
  });

  it("asks for confirmation before pushing and previews the command", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ upstream: null, local: [{ name: "feat", sha: "abc1234", upstream: null, ahead: 0, behind: 0, gone: false, isCurrent: true, worktreePath: null, committedAt: 1, subject: "" }], head: { kind: "branch", name: "feat", sha: "abc1234" } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toContain("git push --no-progress -u --end-of-options origin HEAD");
    await user.click(screen.getByText("Cancel"));
    expect(methods(slot)).toEqual(["overview"]);
  });

  it("pushes a tracked branch by explicit refspec and names the branch it showed", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "push",
        input: { threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "abc1234", lease: null },
      }),
    );
  });

  it("runs a palette request only once the overview is loaded and the row is enabled", async () => {
    const slot = render();
    act(() => requestOpen({ threadId: "t1", action: "fetch" }));
    await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "fetch"]));
  });

  it("refuses a palette request the popup row would refuse", async () => {
    const slot = render({ overview: overview({ remotes: [] }) });
    act(() => requestOpen({ threadId: "t1", action: "push" }));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findByText("Push...");
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    expect(methods(slot)).toEqual(["overview"]);
  });

  it("ignores a window event that carries its own detail", async () => {
    const slot = render();
    act(() => {
      window.dispatchEvent(new CustomEvent("vcs-widget:open", { detail: { threadId: "t1", action: "fetch" } }));
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-branch-popup")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("reads the repository again and keeps a recent outcome when reopened", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({ ok: false, error: { code: "index_locked", message: "The repository index is locked." }, overview: overview() }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    let popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("The repository index is locked.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
    // Long enough that what was read is no longer good enough to paint: a lock
    // or an external checkout has to be able to show up.
    advanceClock(3_000);
    await user.click(slot.getByTestId("vcs-branch-button"));
    popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview", "checkout", "overview"]));
    expect(within(popup).queryByText("The repository index is locked.")).not.toBeNull();
    expect((within(popup).getByLabelText("Search for branches and actions") as HTMLInputElement).value).toBe("");
  });

  it("paints a read that is still fresh when reopened instead of waiting on another", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(methods(slot)).toEqual(["overview"]));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());

    // Reopening straight away: the same branch list, without a second read of
    // the repository behind it.
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    expect(await within(popup).findAllByText("feature")).toHaveLength(2);
    expect(methods(slot)).toEqual(["overview"]);
  });

  it("dates a retained outcome and shows the repository under it", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({ ok: false, error: { code: "index_locked", message: "The repository index is locked." }, overview: overview() }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    let popup = await screen.findByTestId("vcs-branch-popup");
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("The repository index is locked.");
    // Fresh: no age, and the outcome has the status line to itself.
    const line = () => within(popup).getByRole("status").textContent ?? "";
    expect(line()).not.toMatch(/ago/);
    expect(line()).not.toMatch(/repo · origin\/main/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());

    advanceClock(20_000);
    await user.click(slot.getByTestId("vcs-branch-button"));
    popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findByText(/The repository index is locked\. · 20 s ago/);
    expect(line()).toMatch(/repo · origin\/main/);
  });

  it("forgets an outcome older than the retention window", async () => {
    const user = userEvent.setup();
    const slot = render({
      checkout: () => ({ ok: false, error: { code: "index_locked", message: "The repository index is locked." }, overview: overview() }),
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    let popup = await screen.findByTestId("vcs-branch-popup");
    const [featureRow] = await within(popup).findAllByText("feature");
    await user.click(featureRow!);
    await within(popup).findByText("The repository index is locked.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());

    advanceClock(61_000);
    await user.click(slot.getByTestId("vcs-branch-button"));
    popup = await screen.findByTestId("vcs-branch-popup");
    await waitFor(() => expect(within(popup).queryByText(/The repository index is locked/)).toBeNull());
  });

  it("returns from the New Branch step on Escape instead of closing", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("New Branch..."));
    await within(popup).findByLabelText("New branch name");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("vcs-branch-popup")).not.toBeNull();
    await within(popup).findByLabelText("Search for branches and actions");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
  });

  it("hides the Local heading while a filter matches no local branch", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.type(within(popup).getByLabelText("Search for branches and actions"), "hotfix");
    await waitFor(() => expect(within(popup).queryByText("Local")).toBeNull());
    expect(within(popup).getByText("Remote")).toBeTruthy();
  });

  it("reads the overview for a thread bb's sidebar does not list", async () => {
    const slot = render({ offSidebar: true, overview: overview({ head: { kind: "branch", name: "hidden-branch", sha: "abc1234" } }) });
    await waitFor(() => expect(slot.getByTestId("vcs-branch-button").textContent).toContain("hidden-branch"));
  });
});

/**
 * The popup used to render every branch it knew about. It now renders a window
 * over them, and these are the properties that must survive: the DOM stays
 * bounded whatever the repository holds, nothing becomes unreachable, the
 * highlight still walks the list, and Home/End still mean the ends of the
 * list rather than the ends of the window.
 *
 * jsdom has no layout, so the container is given a height the way it is given
 * `matchMedia` and `scrollIntoView` above: a viewport of ten rows at the
 * popup's own row height. `scrollIntoView` is emulated for the same reason —
 * cmdk keeps the highlight in view with it, and the browser's scroll event is
 * what moves the window, so without it the test would not exercise the loop.
 */
describe("popup window", () => {
  const ROW = POPUP_ROW_HEIGHT;
  const VIEWPORT_ROWS = 10;

  /** A repository with more branches than any popup should render at once. */
  function manyBranches(count: number) {
    return overview({
      local: [
        { name: "main", sha: "abc1234", upstream: "origin/main", ahead: 0, behind: 0, gone: false, isCurrent: true, worktreePath: null, committedAt: 1, subject: "" },
        ...Array.from({ length: count }, (_, index) => ({
          name: `perf-${String(index).padStart(4, "0")}`,
          sha: "abc1234",
          upstream: null,
          ahead: 0,
          behind: 0,
          gone: false,
          isCurrent: false,
          worktreePath: null,
          committedAt: 1,
          subject: "",
        })),
      ],
      remote: [],
      recent: [],
    });
  }

  /** Every row the window put in the DOM, in order. */
  const renderedItems = (popup: HTMLElement): HTMLElement[] =>
    Array.from(popup.querySelectorAll<HTMLElement>("[cmdk-item]"));
  const renderedNames = (popup: HTMLElement) =>
    renderedItems(popup).map((item) => item.getAttribute("data-value"));
  const selectedValue = (popup: HTMLElement) =>
    popup.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute("data-value") ?? null;
  const listOf = (popup: HTMLElement) => popup.querySelector<HTMLElement>("[cmdk-list]")!;
  /** The window's start, read back off the top spacer. */
  const windowStart = (popup: HTMLElement) =>
    Math.round(
      Number.parseFloat(popup.querySelector<HTMLElement>('[data-testid="vcs-popup-spacer-top"]')!.style.height || "0") / ROW,
    );

  /** Give the list a viewport, and emulate the browser scrolling it into view. */
  function installLayout(): () => void {
    const height = ROW * VIEWPORT_ROWS;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
    // jsdom stores `scrollTop` only on an element it laid out, and it lays out
    // nothing, so the offset is kept here instead.
    let offset = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => offset,
      set: (value: number) => {
        offset = value;
      },
    });
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      const list = this.closest("[cmdk-list]");
      if (!(list instanceof HTMLElement)) return;
      const position = renderedItems(list).indexOf(this as HTMLElement);
      if (position < 0) return;
      // Where the row sits in the whole list, not just in the window.
      const top = (windowStart(list) + position) * ROW;
      let next = list.scrollTop;
      if (top < next) next = top;
      else if (top + ROW > next + list.clientHeight) next = top + ROW - list.clientHeight;
      if (next === list.scrollTop) return;
      list.scrollTop = next;
      fireEvent.scroll(list);
    };
    return () => {
      delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
      delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
      Element.prototype.scrollIntoView = scrollIntoView;
    };
  }

  it("renders a window of rows rather than every branch", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      const items = renderedItems(popup);
      // A viewport of ten rows plus the overscan either side, and no more. The
      // exact count is the window's, not the repository's: this is the whole
      // point of the change.
      expect(items.length).toBeLessThanOrEqual(VIEWPORT_ROWS + POPUP_WINDOW_OVERSCAN * 2 + 2);
      // A branch far down the list is genuinely not in the DOM.
      expect(within(popup).queryByText("perf-0200")).toBeNull();
      expect(items.length).toBeLessThan(50);
    } finally {
      restoreLayout();
    }
  });

  it("still reaches a branch the window never rendered", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      const input = within(popup).getByLabelText("Search for branches and actions");
      await user.type(input, "perf-0350");
      // Windowing is not truncation: the row the reader asked for is there.
      await waitFor(() => expect(within(popup).getByText("perf-0350")).toBeTruthy());
      await user.click(within(popup).getByText("perf-0350"));
      await waitFor(() =>
        expect(slot.inspection.rpcCalls.at(-1)).toEqual({
          method: "checkout",
          input: { threadId: "t1", target: { kind: "local", name: "perf-0350" } },
        }),
      );
    } finally {
      restoreLayout();
    }
  });

  it("moves the window with the scroll offset", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      expect(windowStart(popup)).toBe(0);

      const list = listOf(popup);
      list.scrollTop = 100 * ROW;
      fireEvent.scroll(list);
      await waitFor(() => expect(windowStart(popup)).toBeGreaterThan(50));
      // The rows at the top are gone and the ones at the offset are here.
      expect(within(popup).queryByText("perf-0000")).toBeNull();
      expect(renderedNames(popup).some((value) => value?.includes("perf-01"))).toBe(true);
    } finally {
      restoreLayout();
    }
  });

  it("walks the highlight down the whole list without stalling or jumping", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      const input = within(popup).getByLabelText("Search for branches and actions");

      // cmdk highlights the first row it registers, so the popup opens on the
      // first quick action and the first press moves to the second. That is
      // how it behaved before the list was windowed.
      await waitFor(() => expect(selectedValue(popup)).toBe("action:update"));
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await waitFor(() => expect(selectedValue(popup)).toBe("action:commit"));

      // Then forty more, which is well past the ten rows the viewport holds:
      // the window has to follow the highlight for the walk to continue.
      for (let press = 0; press < 40; press += 1) fireEvent.keyDown(input, { key: "ArrowDown" });

      const selected = selectedValue(popup);
      expect(selected).not.toBeNull();
      // Forty-one presses from the first of seven quick actions reaches the
      // thirty-fourth local branch, which is deep past the first window: not
      // back at the top of it, which is where cmdk's own loop would put the
      // highlight if the window did not follow.
      expect(selected).toBe("local:local:perf-0033");
      const names = renderedNames(popup);
      expect(names).toContain(selected);
      expect(windowStart(popup)).toBeGreaterThan(0);
    } finally {
      restoreLayout();
    }
  });

  it("sends Home and End to the ends of the list, not the ends of the window", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      const input = within(popup).getByLabelText("Search for branches and actions");

      fireEvent.keyDown(input, { key: "End" });
      await waitFor(() => expect(selectedValue(popup)).toBe("local:local:perf-0399"));
      // The last row of the list is the last row of the window.
      expect(windowStart(popup)).toBeGreaterThan(300);

      fireEvent.keyDown(input, { key: "Home" });
      await waitFor(() => expect(selectedValue(popup)).toBe("action:update"));
      expect(windowStart(popup)).toBe(0);
    } finally {
      restoreLayout();
    }
  });

  it("stops the arrow at the last row instead of looping to the top of the window", async () => {
    const user = userEvent.setup();
    const restoreLayout = installLayout();
    try {
      const slot = render({ overview: manyBranches(400) });
      await user.click(slot.getByTestId("vcs-branch-button"));
      const popup = await screen.findByTestId("vcs-branch-popup");
      await waitFor(() => expect(within(popup).getByText("perf-0000")).toBeTruthy());
      const input = within(popup).getByLabelText("Search for branches and actions");

      fireEvent.keyDown(input, { key: "End" });
      await waitFor(() => expect(selectedValue(popup)).toBe("local:local:perf-0399"));
      fireEvent.keyDown(input, { key: "ArrowDown" });
      // cmdk would wrap here, and across a window that means the first row of
      // the window rather than the first branch. It stays put instead.
      expect(selectedValue(popup)).toBe("local:local:perf-0399");
    } finally {
      restoreLayout();
    }
  });
});

describe("jobs", () => {
  it("starts a fetch job, shows its output and finishes on the realtime event", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Fetch"));
    await within(popup).findByText("Fetching…");
    expect(within(popup).getByText("Cancel")).toBeTruthy();
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "job-fetch", event: { kind: "output", line: "From origin" } });
    await within(popup).findByText("From origin");
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "other", event: { kind: "finished", result: { ok: true, message: "Not ours.", overview: null } } });
    expect(within(popup).queryByText("Not ours.")).toBeNull();
    await slot.behavior.emitRealtime("job", { environmentId: "env1", hostId: "h1", jobId: "job-fetch", event: { kind: "finished", result: { ok: true, message: "Fetched origin.", overview: overview() } } });
    await within(popup).findByText("Fetched origin.");
    expect(within(popup).queryByText("Cancel")).toBeNull();
  });

  it("falls back to polling jobGet and cancels through jobCancel", async () => {
    const user = userEvent.setup();
    const slot = render({
      rpc: {
        jobGet: () => ({ jobId: "job-fetch", kind: "fetch", command: "git fetch", startedAt: 1, status: "finished", finishedAt: 2, output: ["done"], result: { ok: false, error: { code: "network", message: "Fetch failed: no route." }, overview: null } }),
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Fetch"));
    await within(popup).findByText("Fetching…");
    await user.click(within(popup).getByText("Cancel"));
    await waitFor(() => expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("jobCancel"));
    await within(popup).findByText("Fetch failed: no route.", undefined, { timeout: 4_000 });
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("jobGet");
  });

  it("shows another pane's job from the overview with a cancel button", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ activeJob: { jobId: "elsewhere", kind: "pull", command: "git pull", startedAt: Date.now() } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const banner = await within(popup).findByTestId("vcs-active-job");
    expect(banner.textContent).toMatch(/Update Project running/u);
    expect((within(popup).getByText("Fetch").closest("[cmdk-item]") as HTMLElement).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(banner).getByText("Cancel"));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "jobCancel", input: { threadId: "t1", jobId: "elsewhere" } }));
  });
});

describe("context menu", () => {
  it("lists the IntelliJ rows and opens Compare in the side panel", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    const labels = Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => item.textContent?.replace(/F2$/u, "").trim());
    expect(labels).toEqual([
      "Checkout",
      "New Branch from 'feature'...",
      "Checkout and Rebase onto 'main'",
      "Checkout and Update",
      "Compare with 'main'",
      "Show Diff with Working Tree",
      "Show Log",
      "Rebase 'main' onto 'feature'",
      "Merge 'feature' into 'main'",
      "New Worktree from 'feature'...",
      "Update",
      "Push...",
      "Tracked Branch",
      "Rename...",
      "Delete",
      "Add to Favourites",
      "Copy Branch Name",
    ]);
    await user.click(within(menu).getByText("Compare with 'main'"));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "openThreadPanel",
        options: { actionId: "compare", title: "main ⇄ feature", params: { base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } } },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
  });

  it("merges after showing the exact command", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Merge 'feature' into 'main'"));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git merge --no-edit --end-of-options refs/heads/feature");
    await user.click(screen.getByText("Merge", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "merge", input: { threadId: "t1", ref: { kind: "local", name: "feature" } } }));
  });

  it("previews both commands for Checkout and Rebase onto the current branch", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findByText("origin/hotfix");
    const menu = await openMenu(popup, "origin/hotfix");
    await user.click(within(menu).getByText("Checkout and Rebase onto 'main'"));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git switch -c hotfix --track --end-of-options refs/remotes/origin/hotfix\ngit rebase --end-of-options refs/heads/main");
    await user.click(screen.getByText("Rebase", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "rebase",
        input: { threadId: "t1", onto: { kind: "local", name: "main" }, checkoutFirst: { kind: "remote", remote: "origin", branch: "hotfix" } },
      }),
    );
  });

  it("renames from the menu through the inline step", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Rename..."));
    const input = await within(popup).findByLabelText("New name");
    expect((input as HTMLInputElement).value).toBe("feature");
    await user.clear(input);
    await user.type(input, "feature-2{Enter}");
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "renameBranch", input: { threadId: "t1", from: "feature", to: "feature-2" } }));
    await within(popup).findByText("Renamed feature to feature-2.");
  });

  it("deletes with -d, then asks again with -D when the branch is not fully merged", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const slot = render({
      rpc: {
        deleteBranch: (input) => {
          calls += 1;
          return input.force
            ? { ok: true, message: "Deleted feature.", overview: overview() }
            : { ok: false, error: { code: "not_fully_merged", message: "Delete failed: the branch 'feature' is not fully merged" }, overview: overview() };
        },
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    const menu = await openMenu(popup, "feature");
    await user.click(within(menu).getByText("Delete"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git branch -d --end-of-options feature");
    await user.click(screen.getByText("Delete", { selector: "button" }));
    await waitFor(() => expect(calls).toBe(1));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git branch -D --end-of-options feature");
    await user.click(screen.getByText("Delete anyway", { selector: "button" }));
    await waitFor(() => expect(calls).toBe(2));
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "deleteBranch", input: { threadId: "t1", name: "feature", force: true } });
  });

  it("stars a branch into the Favourites group", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await within(popup).findAllByText("feature");
    expect(within(popup).queryByText("Favourites")).toBeNull();
    await user.click(within(popup).getAllByLabelText("Add feature to favourites")[0]!);
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setFavourite", input: { threadId: "t1", name: "local:feature", favourite: true } }));
    await within(popup).findByText("Favourites");
    expect(within(popup).getAllByText("feature").length).toBe(3);
    const menu = await openMenu(popup, "feature");
    expect(within(menu).getByText("Remove from Favourites")).toBeTruthy();
  });
});

describe("operations and force push", () => {
  it("offers Abort while a rebase is in progress", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ operation: "rebase" }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    const banner = await within(popup).findByTestId("vcs-operation-banner");
    expect(banner.textContent).toContain("A rebase is in progress.");
    await user.click(within(banner).getByText("Abort"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git rebase --abort");
    await user.click(screen.getByText("Abort", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "abortOperation", input: { threadId: "t1" } }));
  });

  it("force-pushes only through the lease switch", async () => {
    const user = userEvent.setup();
    const slot = render({ overview: overview({ upstream: { name: "origin/main", remote: "origin", branch: "main", ahead: 1, behind: 1, gone: false } }) });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Push..."));
    const preview = await screen.findByTestId("vcs-command-preview");
    expect(preview.textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByTestId("vcs-confirm-toggle"));
    await waitFor(() => expect(preview.textContent).toBe("git push --no-progress --force-with-lease=refs/heads/main:abc1234 --end-of-options origin HEAD:refs/heads/main"));
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "push",
        input: { threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "abc1234", lease: "abc1234" },
      }),
    );
  });

  it("checks out a tag through the revision step", async () => {
    const user = userEvent.setup();
    const slot = render();
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Checkout Tag or Revision..."));
    await user.click(await within(popup).findByText("v1.0"));
    await user.click(within(popup).getByText("Checkout", { selector: "button" }));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git switch --detach --end-of-options v1.0");
    await user.click(screen.getByText("Checkout", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "checkoutRevision", input: { threadId: "t1", revision: "v1.0" } }));
  });
});

describe("panels", () => {
  it("registers the compare, diff, commit and log panel tabs", () => {
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["compare", "diff", "commit", "log"]);
  });

  it("renders the comparison and a file's patch", async () => {
    const user = userEvent.setup();
    const compare = app.threadPanelActions.find((action) => action.id === "compare")!;
    const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      compare,
      { threadId: "t1", params: { base: { kind: "local", name: "main" }, target: { kind: "local", name: "feature" } } },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        rpc: {
          overview: () => overview(),
          compare: () => ({ ok: true, base: "main", target: "feature", aheadCount: 1, behindCount: 0, ahead: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", author: "Costa", committedAt: 1, subject: "feature work" }], behind: [], files: [{ path: "a.txt", oldPath: null, additions: 1, deletions: 0, binary: false }], truncated: { ahead: false, behind: false, files: false } }),
          comparePatch: (input: { path: string }) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
        } as never,
      },
    );
    await slot.findByText("feature work");
    expect(slot.getByTestId("vcs-compare-counts").textContent).toBe("feature +1 · main +0");
    await user.click(slot.getByText("a.txt"));
    await slot.findByTestId("vcs-patch");
    // The panel reads the overview first: it is what tells a panel with no
    // repository to show the shared empty state instead of an empty frame.
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["overview", "compare", "comparePatch"]);
    const bad = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      compare,
      { threadId: "t1", params: { base: 1 } },
      { rpc: { overview: () => overview() } as never },
    );
    expect(bad.getByText(/Open this tab from a branch/u)).toBeTruthy();
  });

  it("replaces a panel's layout with one shared empty state when there is no repository", async () => {
    const commit = app.threadPanelActions.find((action) => action.id === "commit")!;
    const notRepo: Overview = {
      ...overview(),
      unavailableReason: "The thread workspace is not a git repository.",
      unavailableKind: "not_a_repo",
      repoRoot: null,
      repoName: null,
      head: null,
      local: [],
      remote: [],
    };
    const renderCommit = (view: Overview) =>
      renderSlot<PluginThreadPanelProps, typeof rpcContract>(
        commit,
        { threadId: "t1", params: {} },
        {
          sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
          rpc: {
            overview: () => view,
            changes: () => ({
              ok: false as const,
              error: { code: "not_a_repo" as const, message: "The thread workspace is not a git repository.", hint: "" },
            }),
          } as never,
        },
      );

    const slot = renderCommit(notRepo);
    const empty = await slot.findByTestId("vcs-repository-empty");
    expect(empty.getAttribute("data-kind")).toBe("not_a_repo");
    expect(slot.getByText("Not a Git repository")).toBeTruthy();
    // The server's own sentence survives, and the panel's normal chrome does
    // not: neither the diff stream nor the changed-files list is mounted.
    expect(slot.getByText("The thread workspace is not a git repository.")).toBeTruthy();
    expect(slot.queryByTestId("vcs-stream")).toBeNull();
    expect(slot.queryByTestId("vcs-file-list")).toBeNull();

  });

  it("lets the unavailability kind, not the sentence, choose the empty state's heading", async () => {
    const commit = app.threadPanelActions.find((action) => action.id === "commit")!;
    const slot = renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      commit,
      { threadId: "t1", params: {} },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        rpc: {
          overview: () => ({
            ...overview(),
            unavailableReason: "The thread environment is provisioning.",
            unavailableKind: "provisioning" as const,
            repoRoot: null,
            repoName: null,
          }),
          changes: () => ({
            ok: false as const,
            error: { code: "not_a_repo" as const, message: "The thread environment is provisioning.", hint: "" },
          }),
        } as never,
      },
    );
    expect((await slot.findByTestId("vcs-repository-empty")).getAttribute("data-kind")).toBe("provisioning");
    expect(slot.getByText("The environment is still starting")).toBeTruthy();
    expect(slot.queryByText("Not a Git repository")).toBeNull();
  });
});

describe("CommitPanel", () => {
  type CommitRpc = Record<string, (input: never) => unknown>;

  function renderCommitPanel(options: { changes?: ChangesResult; overview?: Overview; rpc?: CommitRpc } = {}) {
    const view = options.overview ?? overview();
    const panel = app.threadPanelActions.find((action) => action.id === "commit")!;
    return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      panel,
      { threadId: "t1", params: {} },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
        rpc: {
          overview: () => view,
          changes: () => options.changes ?? CHANGES,
          diffFile: (input: { path: string; side: "index" | "worktree" }) => ({ ok: true, path: input.path, side: input.side, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
          diffFiles: (input: { paths: string[]; side: "index" | "worktree" }) => ({
            ok: true,
            files: input.paths.map((path) => ({ path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false })),
          }),
          imagePreview: (input: { path: string; mimeType: string }) => ({ ok: true, path: input.path, mimeType: input.mimeType, old: null, new: null }),
          stage: (input: { paths: string[] }) => ({ ok: true, message: `Staged ${input.paths.length} file(s).`, overview: view }),
          unstage: (input: { paths: string[] }) => ({ ok: true, message: `Unstaged ${input.paths.length} file(s).`, overview: view }),
          discard: () => ({ ok: true, message: "Discarded.", overview: view }),
          commit: () => job("commit"),
          push: () => job("push"),
          jobGet: () => null,
          jobCancel: () => ({ cancelled: true }),
          ...options.rpc,
        } as never,
      },
    );
  }

  const calls = (slot: { inspection: { rpcCalls: { method: string; input: unknown }[] } }, method: string) =>
    slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
  /** The batch reads, typed: `calls` returns `unknown` inputs by design. */
  const batchCalls = (slot: { inspection: { rpcCalls: { method: string; input: unknown }[] } }) =>
    calls(slot, "diffFiles") as { threadId: string; paths: string[]; side: "index" | "worktree" }[];
  /**
   * The panel opens on the directory tree. Tests that assert the status
   * buckets (their headers carry the stage-all and discard-all controls) pick
   * that grouping explicitly.
   */
  const groupByStatus = async (
    user: ReturnType<typeof userEvent.setup>,
    slot: {
      getByTestId: (id: string) => HTMLElement;
      findByTestId: (id: string) => Promise<HTMLElement>;
      findByRole: (role: string, options: { name: string }) => Promise<HTMLElement>;
    },
  ) => {
    // The selector only exists once the first `changes` read has landed.
    await user.click(await slot.findByTestId("vcs-grouping-mode"));
    await user.click(await slot.findByRole("option", { name: "By status" }));
  };

  it("lists the working tree in groups with the checkbox as the staged state", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await groupByStatus(user, slot);
    await slot.findAllByText("staged.txt");
    expect(slot.getByText("Changes")).toBeTruthy();
    expect(slot.getByText("Unversioned files")).toBeTruthy();
    expect(slot.getByTestId("vcs-commit-counts").textContent).toBe("2 staged · 2 unstaged");
    expect(slot.getByLabelText("Unstage staged.txt").getAttribute("aria-checked")).toBe("true");
    expect(slot.getByLabelText("Stage edited.txt").getAttribute("aria-checked")).toBe("false");
    expect(slot.getByLabelText("Unstage both.txt").getAttribute("aria-checked")).toBe("mixed");
    expect(slot.getByLabelText("Stage new.txt").getAttribute("aria-checked")).toBe("false");
    expect(slot.queryByText("Nothing to commit: the working tree is clean.")).toBeNull();
  });

  it("stages and unstages through the checkboxes, whole groups through the header", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await groupByStatus(user, slot);
    await user.click(await slot.findByLabelText("Stage edited.txt"));
    await waitFor(() => expect(calls(slot, "stage")).toEqual([{ threadId: "t1", paths: ["edited.txt"] }]));
    await user.click(slot.getByLabelText("Unstage staged.txt"));
    await waitFor(() => expect(calls(slot, "unstage")).toEqual([{ threadId: "t1", paths: ["staged.txt"] }]));
    // Both ticks are still optimistic here (no server read has landed), so the
    // group now holds staged.txt as unstaged, edited.txt as staged, and
    // both.txt as partially staged. "Stage all" therefore covers the first
    // and third; edited.txt is already staged.
    await user.click(slot.getByLabelText("Stage all in Changes"));
    await waitFor(() => expect(calls(slot, "stage").at(-1)).toEqual({ threadId: "t1", paths: ["staged.txt", "both.txt"] }));
  });

  it("shows a tick at once, before the server's own view of the tree arrives", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    const box = (await slot.findByLabelText("Stage edited.txt")) as HTMLButtonElement;
    // The fixture has edited.txt unstaged; the checkbox reflects that.
    expect(box.getAttribute("aria-checked")).toBe("false");
    await user.click(box);
    // The tick lands without waiting for a `changes` read, and the row is not
    // left disabled: a global busy flag greyed out every row for the length
    // of the round trip, which is the flicker this avoids.
    await waitFor(() => expect(box.getAttribute("aria-checked")).toBe("true"));
    expect(box.disabled).toBe(false);
    expect(slot.getByLabelText("Unstage edited.txt")).toBeTruthy();
  });

  it("reads both sides on its own, and shows a file that has both as two rows", async () => {
    const slot = renderCommitPanel();
    // Neither side waits to be picked: a batch read names exactly one side, so
    // the panel keeps one reader per side and both run.
    await waitFor(() => expect(batchCalls(slot).some((call) => call.side === "worktree")).toBe(true));
    await waitFor(() => expect(batchCalls(slot).some((call) => call.side === "index")).toBe(true));
    expect(batchCalls(slot).find((call) => call.side === "worktree")?.paths).toContain("both.txt");
    expect(batchCalls(slot).find((call) => call.side === "index")?.paths).toContain("both.txt");
    // both.txt is staged and edited again, so it holds a row on each side, and
    // the staged change is the one that comes first.
    const rows = await slot.findAllByTestId(/^vcs-stream-row-both\.txt-/u);
    expect(rows.map((row) => row.getAttribute("data-channel"))).toEqual(["index", "worktree"]);
    expect(slot.getByTestId("vcs-stream-side-tag-both.txt-index").textContent).toBe("Staged");
    expect(slot.getByTestId("vcs-stream-side-tag-both.txt-worktree").textContent).toBe("Unstaged");
    // The mode switch is gone: there is nothing to pick.
    expect(slot.queryByTestId("vcs-stream-side-index")).toBeNull();
  });

  it("quotes a diff line into the composer from the gutter button", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    const row = await slot.findByTestId("vcs-stream-patch-both.txt-worktree");
    // The diffFiles mock answers "@@ -1 +1 @@\n-a\n+b\n", so line 1 of the new
    // side is "+b"; the quote is the patch fragment an agent reads. The same
    // file also has a staged row, hence the scoped lookup.
    await user.click(within(row).getByTestId("vcs-diff-gutter-both.txt"));
    expect(slot.inspection.composer.quotes).toEqual(["both.txt\n@@ -0,0 +1 @@\n+b"]);
  });

  it("drops a range's commit list when the base moves under it", async () => {
    const user = userEvent.setup();
    const commitsFor = (branch: string) => [
      {
        sha: (branch === "main" ? "a" : "b").repeat(40),
        shortSha: branch === "main" ? "aaaaaaa" : "bbbbbbb",
        author: "Costa",
        committedAt: 2,
        subject: branch === "main" ? "On main" : "On feature",
      },
    ];
    const slot = renderCommitPanel({
      rpc: {
        diffTarget: (input: { target: { base?: { branch: string } } }) => ({
          ok: true,
          files: [],
          commits: commitsFor(input.target.base?.branch ?? ""),
          truncated: false,
        }),
      },
    });
    await slot.findAllByText("staged.txt");
    await user.click(slot.getByTestId("vcs-diff-target"));
    await user.click(await slot.findByRole("option", { name: /All commits vs origin\/main/u }));
    // The list belongs to the base the range is measured from.
    await user.click(slot.getByTestId("vcs-diff-target"));
    expect(await slot.findByRole("option", { name: /On main/u })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(slot.getByTestId("vcs-diff-base"));
    await user.click(await slot.findByRole("option", { name: "feature" }));
    await waitFor(() => expect(slot.getByTestId("vcs-diff-base-label").textContent).toBe("feature"));
    // A list kept past a base change would name commits the new range does not
    // hold, which is worse than offering none at all: it is dropped at once,
    // before the new base's own read lands.
    await user.click(slot.getByTestId("vcs-diff-target"));
    expect(slot.queryByRole("option", { name: /On main/u })).toBeNull();
    expect(await slot.findByRole("option", { name: /On feature/u })).toBeTruthy();
  });

  it("hands the wrap toggle to the renderer, not only to the frame around it", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    const row = await slot.findByTestId("vcs-stream-patch-both.txt-worktree");
    // Whether a long line wraps is a renderer option, so relaxing the frame's
    // own overflow is not enough: the renderer has to hear about it too.
    const renderer = row.querySelector("[data-overflow]")!;
    expect(renderer.getAttribute("data-overflow")).toBe("scroll");
    await user.click(slot.getByTestId("vcs-diff-wrap"));
    await waitFor(() => expect(renderer.getAttribute("data-overflow")).toBe("wrap"));
  });


  it("points the pane at a commit range and reads that range instead", async () => {
    const user = userEvent.setup();
    const commits = [{ sha: "c".repeat(40), shortSha: "ccccccc", author: "Costa", committedAt: 2, subject: "Second" }];
    const slot = renderCommitPanel({
      rpc: {
        diffTarget: () => ({
          ok: true,
          files: [{ path: "committed.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked", additions: 4, deletions: 1 }],
          commits,
          truncated: false,
        }),
      },
    });
    await slot.findAllByText("staged.txt");
    // The pane starts on the working tree, with its own picker and no base.
    expect(slot.getByTestId("vcs-diff-target-label").textContent).toBe("Uncommitted changes");
    expect(slot.queryByTestId("vcs-diff-base")).toBeNull();
    await user.click(slot.getByTestId("vcs-diff-target"));
    await user.click(await slot.findByRole("option", { name: /All commits vs origin\/main/u }));
    // The base is the branch the work will land on, and it is what the range
    // is measured from.
    await waitFor(() =>
      expect(calls(slot, "diffTarget").at(-1)).toEqual({
        threadId: "t1",
        target: { kind: "commits", base: { kind: "remote", remote: "origin", branch: "main" } },
      }),
    );
    expect(slot.getByTestId("vcs-diff-base-label").textContent).toBe("origin/main");
    // The list is the range's, and it is read-only: a committed file has
    // nothing to stage and nothing to discard.
    const list = slot.getByTestId("vcs-file-list");
    await waitFor(() => expect(list.querySelector('[data-path="committed.txt"]')).not.toBeNull());
    const row = list.querySelector('[data-path="committed.txt"]')!;
    expect(row.querySelector("[role=checkbox]")).toBeNull();
    expect(row.querySelector("[data-testid=vcs-file-stats]")?.textContent).toBe("+4-1");
    // Its patch comes from the target read, not from a side of the index.
    await waitFor(() => expect(calls(slot, "diffTargetPatches").length).toBeGreaterThan(0));
    expect(calls(slot, "diffTargetPatches").at(-1)).toMatchObject({
      threadId: "t1",
      target: { kind: "commits", base: { kind: "remote", remote: "origin", branch: "main" } },
    });
    expect(await slot.findByTestId("vcs-stream-row-committed.txt-target")).toBeTruthy();
    // A target row wears no Staged/Unstaged tag: there is no index side to name.
    expect(slot.queryByTestId("vcs-stream-side-tag-committed.txt-target")).toBeNull();
  });

  it("carries the line counts and the tick on the right of a file row", async () => {
    const slot = renderCommitPanel();
    await slot.findAllByText("staged.txt");
    const list = slot.getByTestId("vcs-file-list");
    const row = (path: string) => list.querySelector(`[data-path="${path}"]`)!;
    // The counts sit beside the name; the tick is the last thing in the row,
    // which is where a hand goes looking for it once the name is long.
    expect(row("staged.txt").querySelector("[data-testid=vcs-file-stats]")?.textContent).toBe("+3-1");
    expect(row("both.txt").querySelector("[data-testid=vcs-file-stats]")?.textContent).toBe("+5-4");
    expect(row("edited.txt").querySelector("[data-testid=vcs-file-stats]")?.textContent).toBe("+2");
    expect(row("staged.txt").lastElementChild?.getAttribute("role")).toBe("checkbox");
  });

  it("keeps the diffs on screen when a tick makes the panel re-read the tree", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    // Wait until a patch is actually rendered.
    await slot.findByTestId("vcs-stream-patch-both.txt-worktree");
    await user.click(await slot.findByLabelText("Stage new.txt"));
    await waitFor(() => expect(calls(slot, "stage")).toHaveLength(1));
    // The optimistic tick replaces the panel's own view of the tree. That used
    // to drop every cached patch, so one tick flashed the whole column back to
    // "Reading diff…" and re-read files nothing had touched. A patch already on
    // screen now stays until its background re-read lands.
    expect(slot.queryByTestId("vcs-stream-loading-both.txt-worktree")).toBeNull();
    expect(slot.getByTestId("vcs-stream-patch-both.txt-worktree")).toBeTruthy();
  });

  it("mounts only the cards near the viewport, and holds a far row's space with a spacer", async () => {
    // jsdom has no IntersectionObserver, so the stream mounts every row. This
    // stands in for a browser: the test says which rows are near the viewport.
    class IntersectionObserverStub {
      static readonly instances: IntersectionObserverStub[] = [];
      readonly elements = new Set<Element>();
      constructor(
        private readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit,
      ) {
        IntersectionObserverStub.instances.push(this);
      }
      observe(element: Element) { this.elements.add(element); }
      unobserve(element: Element) { this.elements.delete(element); }
      disconnect() { this.elements.clear(); }
      takeRecords() { return []; }
      /** Report the targets `near` accepts as close by and the rest as far away. */
      report(near: (element: HTMLElement) => boolean) {
        const entries = [...this.elements].map((target) => {
          const intersecting = near(target as HTMLElement);
          return { target, isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0 };
        }) as IntersectionObserverEntry[];
        act(() => this.callback(entries, this as unknown as IntersectionObserver));
      }
    }
    Object.assign(globalThis, { IntersectionObserver: IntersectionObserverStub });
    try {
      const slot = renderCommitPanel();
      await slot.findAllByTestId(/^vcs-stream-row-/u);
      // The stream keeps one reader per concern, so the newest observer with
      // each margin is the live one.
      const newest = (rootMargin: string) =>
        [...IntersectionObserverStub.instances]
          .reverse()
          .find((instance) => instance.options?.rootMargin === rootMargin);
      const row = (element: HTMLElement) => ({ path: element.dataset.path, side: element.dataset.channel });
      // Start with everything on screen: both sides of both.txt read and render.
      newest(PATCH_ROOT_MARGIN)!.report(() => true);
      newest("800px 0px")!.report(() => true);
      await slot.findByTestId("vcs-stream-patch-both.txt-index");
      await slot.findByTestId("vcs-stream-patch-both.txt-worktree");
      // Now the reader scrolls until only one card is left nearby.
      newest("800px 0px")!.report((element) => row(element).path === "both.txt" && row(element).side === "worktree");
      // The card that scrolled away keeps its place: a spacer the height of its
      // two changed lines, and no renderer behind it. The mounted card stays.
      const spacer = await slot.findByTestId("vcs-stream-spacer-both.txt-index");
      expect(spacer.style.height).toBe("44px");
      expect(slot.queryByTestId("vcs-stream-patch-both.txt-index")).toBeNull();
      expect(slot.getByTestId("vcs-stream-patch-both.txt-worktree")).toBeTruthy();
    } finally {
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  /**
   * A wrapping diff is laid out as a grid whose columns span every row, so
   * every width change makes the browser re-wrap the whole diff and re-solve
   * that grid — measured at about 180ms a frame, against 0-1ms with scrolling
   * lines. The library has no option for it, so the column is pinned to the
   * width it had at rest while the pane is resized and released when the resize
   * settles. These lock that, and lock that the scrolling case is left alone.
   */
  describe("the wrap pin", () => {
    /** jsdom lays nothing out, so the stream is given a width the test controls. */
    function installWidth(width: number): { set: (next: number) => void; restore: () => void } {
      let current = width;
      const bounds = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
        const isStream = (this as HTMLElement).dataset?.testid === "vcs-stream";
        return {
          x: 0, y: 0, top: 0, left: 0, bottom: 0, right: isStream ? current : 0,
          width: isStream ? current : 0, height: 0, toJSON: () => ({}),
        } as DOMRect;
      };
      return {
        set: (next: number) => {
          current = next;
        },
        restore: () => {
          Element.prototype.getBoundingClientRect = bounds;
        },
      };
    }

    class ResizeObserverStub {
      static readonly instances: ResizeObserverStub[] = [];
      readonly elements = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) {
        ResizeObserverStub.instances.push(this);
      }
      observe(element: Element) {
        this.elements.add(element);
      }
      unobserve(element: Element) {
        this.elements.delete(element);
      }
      disconnect() {
        this.elements.clear();
      }
      /** Report the container as having taken this width. */
      report(width: number) {
        const entries = [...this.elements].map((target) => ({
          target,
          contentRect: { width, height: 0, top: 0, left: 0, bottom: 0, right: width, x: 0, y: 0 },
        })) as unknown as ResizeObserverEntry[];
        act(() => this.callback(entries, this as unknown as ResizeObserver));
      }
    }

    /**
     * Swap in the stub for the duration of one test. The file installs its own
     * `ResizeObserver` in `beforeAll`, so this restores that one rather than
     * deleting the global and starving every test after this.
     */
    function installObserver(): () => void {
      const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      ResizeObserverStub.instances.length = 0;
      Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
      return () => {
        if (previous === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        else Object.assign(globalThis, { ResizeObserver: previous });
      };
    }

    const wrapOn = () => window.localStorage.setItem("vcs-widget.diff-wrap.t1", "true");
    const column = (slot: { getByTestId: (id: string) => HTMLElement }) => slot.getByTestId("vcs-stream-column");
    const latest = () => [...ResizeObserverStub.instances].reverse()[0]!;

    it("does not pin anything while long lines scroll", async () => {
      const layout = installWidth(600);
      const restoreObserver = installObserver();
      try {
        const slot = renderCommitPanel();
        await slot.findAllByTestId(/^vcs-stream-row-/u);
        latest().report(640);
        // Nothing to save: a scrolling diff costs 0-1ms a width change, and its
        // content follows the drag while it happens.
        expect(column(slot).style.width).toBe("");
      } finally {
        layout.restore();
        restoreObserver();
      }
    });

    it("holds a wrapping diff's width while the pane is resized, and lets go when it settles", async () => {
      wrapOn();
      const layout = installWidth(600);
      const restoreObserver = installObserver();
      try {
        const slot = renderCommitPanel();
        await slot.findAllByTestId(/^vcs-stream-row-/u);
        expect(column(slot).style.width).toBe("");

        layout.set(640);
        latest().report(640);
        // Pinned to where it was, so the renderer has nothing to re-wrap.
        expect(column(slot).style.width).toBe("600px");
        expect(column(slot).style.minWidth).toBe("600px");

        // Still pinned while the drag continues.
        layout.set(580);
        latest().report(580);
        expect(column(slot).style.width).toBe("600px");

        // Quiet for the settle window: one relayout, at the width it landed on.
        // Waited out rather than advanced: the settle is a real timer, and
        // `advanceClock` only moves `Date.now()`.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, DIFF_WRAP_PIN_SETTLE_MS + 40));
        });
        expect(column(slot).style.width).toBe("");

        // And a resize back to where it settled has nothing to pin for.
        latest().report(580);
        expect(column(slot).style.width).toBe("");
      } finally {
        layout.restore();
        restoreObserver();
      }
    });

    it("pins before the first width change when the panel's own splitter moves", async () => {
      wrapOn();
      const layout = installWidth(600);
      const restoreObserver = installObserver();
      try {
        const slot = renderCommitPanel();
        await slot.findAllByText("staged.txt");
        const resizer = slot.getByTestId("vcs-file-list-resizer");

        // A drag this panel started pins straight away: a resize the observer
        // sees has already been laid out once, and that frame is the one the
        // drag begins on.
        fireEvent.pointerDown(resizer, { clientX: 1000 });
        await waitFor(() => expect(column(slot).style.width).toBe("600px"));

        fireEvent.pointerUp(window);
        await waitFor(() => expect(column(slot).style.width).toBe(""));
      } finally {
        layout.restore();
        restoreObserver();
      }
    });
  });

  it("commits the index with the message as a job and clears the message when it finishes", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findAllByText("staged.txt");
    const button = slot.getByTestId("vcs-commit-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.type(slot.getByTestId("vcs-commit-message"), "Ship it");
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "commit")).toEqual([{ threadId: "t1", message: "Ship it", amend: false, signoff: false, noVerify: false }]));
    expect(slot.getByTestId("vcs-commit-busy")).toBeTruthy();
    await slot.behavior.emitRealtime("job", { jobId: "job-commit", event: { kind: "finished", result: { ok: true, message: "Committed abc1234: Ship it", overview: overview() } } });
    await waitFor(() => expect((slot.getByTestId("vcs-commit-message") as HTMLTextAreaElement).value).toBe(""));
    expect(slot.getByText("Committed abc1234: Ship it")).toBeTruthy();
  });

  it("refuses to commit while blocked, and without anything staged", async () => {
    const slot = renderCommitPanel({ changes: { ...CHANGES, indexLocked: true } });
    await waitFor(() => expect(slot.getAllByTestId("vcs-file-list").length).toBeGreaterThan(0));
    expect(slot.getByText("Another git process holds the index lock.")).toBeTruthy();
    // A second panel is mounted beside the first, so this one's nodes are
    // reached through its own container rather than the shared screen.
    const empty = renderCommitPanel({ changes: { ...CHANGES, files: [CHANGES.files[1]!] } });
    const emptyList = empty.getAllByTestId("vcs-file-list").at(-1)!;
    await waitFor(() => expect(within(emptyList).getByText("edited.txt")).toBeTruthy());
    expect(empty.getByText("Nothing is staged: tick the files to include.")).toBeTruthy();
  });

  it("amend prefills the last message and asks first with the exact command", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findAllByText("staged.txt");
    await user.click(slot.getByLabelText("Amend"));
    expect((slot.getByTestId("vcs-commit-message") as HTMLTextAreaElement).value).toBe("Last one\n\nBody");
    await user.click(slot.getByLabelText("Sign-off"));
    await user.click(slot.getByTestId("vcs-commit-button"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git commit -F - --amend --signoff");
    await user.click(screen.getByText("Amend", { selector: "button[type=button]" }));
    await waitFor(() => expect(calls(slot, "commit")).toEqual([{ threadId: "t1", message: "Last one\n\nBody", amend: true, signoff: true, noVerify: false }]));
  });

  it("discard asks with one command per category and runs nothing on cancel", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findByTestId("vcs-file-list");
    await user.click(slot.getByLabelText("Discard changes in new.txt"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs clean -f -- new.txt");
    await user.click(screen.getByText("Cancel"));
    expect(calls(slot, "discard")).toEqual([]);
    await user.click(slot.getByLabelText("Discard changes in staged.txt"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs restore --staged --worktree --source=HEAD -- staged.txt");
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: ["staged.txt"], remove: [], clean: [] }]));
  });

  /** Right-clicks a file row and returns its menu. */
  async function openFileMenu(slot: { getByTestId: (id: string) => HTMLElement }, path: string) {
    // Scope to the file list: the diff stream also renders each path in its
    // own row header, so a document-wide text query matches twice.
    const list = slot.getByTestId("vcs-file-list");
    const row = within(list).getByText(path).closest("[data-path]");
    if (!(row instanceof HTMLElement)) throw new Error(`no row for ${path}`);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    return screen.findByTestId("vcs-file-menu");
  }

  it("right-clicks a file for Copy Path and Discard", async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } },
    });
    const slot = renderCommitPanel();
    await slot.findAllByText("staged.txt");
    const menu = await openFileMenu(slot, "staged.txt");
    expect(Array.from(menu.querySelectorAll("[role=menuitem]")).map((item) => item.textContent)).toEqual(["Copy Path", "Discard"]);
    await user.click(within(menu).getByText("Copy Path"));
    await waitFor(() => expect(copied).toEqual(["staged.txt"]));
    expect(slot.getByTestId("vcs-commit-notice").textContent).toContain("Copied staged.txt");
    // The menu item is the row's discard button by another name.
    const untracked = await openFileMenu(slot, "new.txt");
    await user.click(within(untracked).getByText("Discard"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git --literal-pathspecs clean -f -- new.txt");
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: [], remove: [], clean: ["new.txt"] }]));
  });

  it("discards a whole group from its header, and leaves Conflicts without the button", async () => {
    const user = userEvent.setup();
    const conflicted = { path: "clash.txt", oldPath: null, index: "U", worktree: "U", kind: "conflicted" as const, additions: null, deletions: null };
    const slot = renderCommitPanel({ changes: { ...CHANGES, files: [...CHANGES.files, conflicted] } });
    await groupByStatus(user, slot);
    await slot.findAllByText("staged.txt");
    expect(slot.queryByLabelText("Discard all changes in Conflicts")).toBeNull();
    await user.click(slot.getByLabelText("Discard all changes in Changes"));
    expect(await screen.findByText("Discard changes in 3 files")).toBeTruthy();
    expect(screen.getByTestId("vcs-command-preview").textContent).toBe(
      "git --literal-pathspecs restore --staged --worktree --source=HEAD -- staged.txt edited.txt both.txt",
    );
    await user.click(screen.getByText("Discard", { selector: "button" }));
    await waitFor(() =>
      expect(calls(slot, "discard")).toEqual([{ threadId: "t1", restore: ["staged.txt", "edited.txt", "both.txt"], remove: [], clean: [] }]),
    );
  });

  it("refuses a group discard whose paths would not fit one call", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `${"d".repeat(3000)}/${index}.txt`,
      oldPath: null,
      index: ".",
      worktree: "M",
      kind: "tracked" as const,
      additions: null,
      deletions: null,
    }));
    const slot = renderCommitPanel({ changes: { ...CHANGES, files } });
    await groupByStatus(user, slot);
    await slot.findByLabelText("Discard all changes in Changes");
    await user.click(slot.getByLabelText("Discard all changes in Changes"));
    expect(await slot.findByText("Too many files for one discard.")).toBeTruthy();
    expect(slot.getByText("Discard them in smaller groups.")).toBeTruthy();
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    expect(calls(slot, "discard")).toEqual([]);
  });

  it("hands the commit to the thread's agent whatever is staged", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({ rpc: { sendToAgent: () => ({ ok: true, delivery: "queued" }) } });
    await slot.findAllByText("staged.txt");
    const button = slot.getByTestId("vcs-agent-commit-button") as HTMLButtonElement;
    // The label names the actor, because "Commit" is taken by the button beside it.
    expect(button.textContent).toBe("Agent Commit");
    // Commit itself is refused without a message; this one never is.
    expect((slot.getByTestId("vcs-commit-button") as HTMLButtonElement).disabled).toBe(true);
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "sendToAgent")).toEqual([{ threadId: "t1", variant: "commit" }]));
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("queued");
  });

  it("asks the agent to push too, without ever naming the text it sends", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({ rpc: { sendToAgent: () => ({ ok: true, delivery: "sent" }) } });
    await slot.findAllByText("staged.txt");
    const button = slot.getByTestId("vcs-agent-commit-push-button") as HTMLButtonElement;
    expect(button.textContent).toBe("Agent Commit & Push");
    // Enabled with no upstream, unlike the panel's own push: the agent is the
    // one that can set one up, so a disabled button would hide the way out.
    expect(button.disabled).toBe(false);
    await user.click(button);
    await waitFor(() => expect(calls(slot, "sendToAgent")).toEqual([{ threadId: "t1", variant: "commit-push" }]));
    // The notice quotes what went to the agent, which is not what the button says.
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("LGTM - Commit & Push");
  });

  it("reports an agent that could not be reached", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel({
      rpc: { sendToAgent: () => ({ ok: false, error: { code: "git_failed", message: "The message did not reach the agent: no such thread" } }) },
    });
    await slot.findAllByText("staged.txt");
    await user.click(slot.getByTestId("vcs-agent-commit-button"));
    expect((await slot.findByTestId("vcs-commit-notice")).textContent).toContain("did not reach the agent");
  });

  it("Commit and Push follows the commit with the push dialog on the overview the commit reported", async () => {
    const user = userEvent.setup();
    const slot = renderCommitPanel();
    await slot.findAllByText("staged.txt");
    await user.type(slot.getByTestId("vcs-commit-message"), "Ship and push");
    await user.click(slot.getByTestId("vcs-commit-push-button"));
    await waitFor(() => expect(calls(slot, "commit")).toHaveLength(1));
    const after = overview({ head: { kind: "branch", name: "main", sha: "def5678" } });
    await slot.behavior.emitRealtime("job", { jobId: "job-commit", event: { kind: "finished", result: { ok: true, message: "Committed def5678: Ship and push", overview: after } } });
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe("git push --no-progress --end-of-options origin HEAD:refs/heads/main");
    await user.click(screen.getByText("Push", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "push")).toEqual([{ threadId: "t1", remote: "origin", setUpstream: false, expectedBranch: "main", source: "head", expectedSha: "def5678", lease: null }]));
  });

  /**
   * The file list used to render every row it had: a worktree with hundreds of
   * changed files put hundreds of Radix-wrapped rows in the DOM and rebuilt all
   * of them on every drag of the splitter. These are the properties that have to
   * survive being windowed — the DOM stays bounded, a collapsed folder takes its
   * files with it, the splitter writes once, and the diff reader asks for what
   * is near the reader rather than for everything that is not.
   *
   * jsdom has no layout, so the list is given a viewport and a scroll offset the
   * same way it is given `matchMedia` and `scrollIntoView`.
   */
  describe("windowed file list", () => {
    const VIEWPORT_ROWS = 10;
    const VIEWPORT_HEIGHT = CHANGE_LIST_ROW_HEIGHT * VIEWPORT_ROWS;

    /** A working tree with more files than any list should render at once. */
    function manyFiles(count: number): ChangesResult {
      // `ChangesResult` is the ok branch or a failure; this fixture is the ok one.
      const readable = CHANGES as Extract<ChangesResult, { ok: true }>;
      return {
        ...readable,
        files: [
          ...Array.from({ length: count }, (_, index) => ({
            path: `bulk/file-${String(index).padStart(4, "0")}.txt`,
            oldPath: null,
            index: ".",
            worktree: "M",
            kind: "tracked" as const,
            additions: 1,
            deletions: 0,
          })),
          { path: "other/one.txt", oldPath: null, index: ".", worktree: "M", kind: "tracked" as const, additions: 1, deletions: 0 },
        ],
      };
    }

    /** Give every element a height and a scroll offset, which jsdom does not. */
    function installLayout(): () => void {
      let offset = 0;
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => VIEWPORT_HEIGHT });
      Object.defineProperty(HTMLElement.prototype, "scrollTop", {
        configurable: true,
        get: () => offset,
        set: (value: number) => {
          offset = value;
        },
      });
      const bounds = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
        const rect = bounds.call(this);
        // The split's right edge, so the drag has something to measure against.
        return { ...rect, right: 1000, left: 0, width: 1000, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      };
      // jsdom has no PointerEvent, so `fireEvent.pointerMove` falls back to a
      // plain Event and drops the coordinates a drag is made of. Only the drag
      // tests need one, so it is installed here rather than for the file.
      const pointerEvent = (globalThis as { PointerEvent?: unknown }).PointerEvent;
      class PointerEventStub extends MouseEvent {}
      Object.assign(globalThis, { PointerEvent: PointerEventStub });
      return () => {
        delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
        delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
        Element.prototype.getBoundingClientRect = bounds;
        if (pointerEvent === undefined) delete (globalThis as { PointerEvent?: unknown }).PointerEvent;
        else Object.assign(globalThis, { PointerEvent: pointerEvent });
      };
    }

    const fileRows = (slot: { getByTestId: (id: string) => HTMLElement }) =>
      Array.from(slot.getByTestId("vcs-file-list").querySelectorAll<HTMLElement>("li[data-path]"));
    const listOf = (slot: { getByTestId: (id: string) => HTMLElement }) =>
      slot.getByTestId("vcs-change-tree") as HTMLElement;
    /** The window's start, read back off the top spacer. */
    const windowStart = (slot: { getByTestId: (id: string) => HTMLElement }) =>
      Math.round(
        Number.parseFloat(listOf(slot).querySelector<HTMLElement>('[data-testid="vcs-change-list-spacer-top"]')!.style.height || "0") /
          CHANGE_LIST_ROW_HEIGHT,
      );

    it("renders a window of file rows rather than every changed file", async () => {
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: manyFiles(400) });
        await waitFor(() => expect(fileRows(slot).length).toBeGreaterThan(0));
        const rendered = fileRows(slot);
        // A viewport of ten rows plus the window's overscan either side.
        expect(rendered.length).toBeLessThanOrEqual(VIEWPORT_ROWS + CHANGE_LIST_WINDOW_OVERSCAN * 2 + 2);
        expect(rendered.length).toBeLessThan(50);
        // A file far down the list is genuinely not in the DOM.
        expect(slot.queryByText("file-0200.txt")).toBeNull();
        expect(slot.queryByText("file-0000.txt")).toBeTruthy();
      } finally {
        restore();
      }
    });

    it("moves the window with the list's own scroll offset", async () => {
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: manyFiles(400) });
        await waitFor(() => expect(fileRows(slot).length).toBeGreaterThan(0));
        expect(windowStart(slot)).toBe(0);

        const list = listOf(slot);
        list.scrollTop = 100 * CHANGE_LIST_ROW_HEIGHT;
        fireEvent.scroll(list);
        await waitFor(() => expect(windowStart(slot)).toBeGreaterThan(50));
        // The window is showing the rows at the offset, not the ones at the top.
        // The tree's root holds one directory row before the files.
        expect(slot.queryByText("file-0000.txt")).toBeNull();
        expect(fileRows(slot).length).toBeLessThan(50);
      } finally {
        restore();
      }
    });

    it("takes a collapsed folder's files out of the list, and with them the window", async () => {
      const user = userEvent.setup();
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: manyFiles(400) });
        await waitFor(() => expect(slot.getByLabelText("Collapse bulk")).toBeTruthy());
        expect(fileRows(slot).length).toBeGreaterThan(0);

        await user.click(slot.getByLabelText("Collapse bulk"));
        await waitFor(() => expect(slot.queryByText("file-0000.txt")).toBeNull());
        // The folder keeps its own row, so it can be opened again.
        expect(slot.getByLabelText("Collapse bulk")).toBeTruthy();
        // Only the other directory's file is left to render.
        expect(Array.from(fileRows(slot)).map((row) => row.dataset.path)).toEqual(["other/one.txt"]);
      } finally {
        restore();
      }
    });

    it("writes the dragged width to the DOM as it moves, and to storage once", async () => {
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: CHANGES });
        await slot.findAllByText("staged.txt");
        // On the prototype: jsdom's `window.localStorage` is a proxy whose own
        // properties a spy does not intercept.
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const widthKey = "vcs-widget.right-pane-width.t1";
        const writesFor = () => setItem.mock.calls.filter((call) => call[0] === widthKey).length;
        const before = writesFor();

        const resizer = slot.getByTestId("vcs-file-list-resizer");
        const pane = slot.getByTestId("vcs-file-list");
        fireEvent.pointerDown(resizer, { clientX: 1000 });
        // Three moves: the pane follows all of them, storage none of them. The
        // write is put off to the next frame, so each one is waited for.
        for (const clientX of [700, 600, 500]) {
          fireEvent.pointerMove(window, { clientX });
          await waitFor(() => expect(pane.style.width).toBe(`${1000 - clientX}px`));
        }
        expect(writesFor()).toBe(before);

        fireEvent.pointerUp(window);
        // One write for the whole drag, at the width it landed on.
        expect(writesFor()).toBe(before + 1);
        expect(pane.style.width).toBe("500px");
      } finally {
        restore();
      }
    });

    it("clamps a drag that would collapse either pane", async () => {
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: CHANGES });
        await slot.findAllByText("staged.txt");
        const resizer = slot.getByTestId("vcs-file-list-resizer");
        const pane = slot.getByTestId("vcs-file-list");
        fireEvent.pointerDown(resizer, { clientX: 1000 });
        fireEvent.pointerMove(window, { clientX: 1000 });
        await waitFor(() => expect(pane.style.width).toBe(`${PANE_WIDTH.min}px`));
        fireEvent.pointerMove(window, { clientX: 0 });
        await waitFor(() => expect(pane.style.width).toBe(`${PANE_WIDTH.max}px`));
        fireEvent.pointerUp(window);
      } finally {
        restore();
      }
    });

    it("asks for the diffs near the reader, not for every row that is not", async () => {
      class IntersectionObserverStub {
        static readonly instances: IntersectionObserverStub[] = [];
        readonly elements = new Set<Element>();
        constructor(
          private readonly callback: IntersectionObserverCallback,
          readonly options?: IntersectionObserverInit,
        ) {
          IntersectionObserverStub.instances.push(this);
        }
        observe(element: Element) {
          this.elements.add(element);
        }
        unobserve(element: Element) {
          this.elements.delete(element);
        }
        disconnect() {
          this.elements.clear();
        }
        takeRecords() {
          return [];
        }
        report(near: (element: HTMLElement) => boolean) {
          const entries = Array.from(this.elements).map((target) => {
            const intersecting = near(target as HTMLElement);
            return { target, isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0 };
          }) as IntersectionObserverEntry[];
          act(() => this.callback(entries, this as unknown as IntersectionObserver));
        }
      }
      Object.assign(globalThis, { IntersectionObserver: IntersectionObserverStub });
      const restore = installLayout();
      try {
        const slot = renderCommitPanel({ changes: manyFiles(400) });
        await slot.findAllByTestId(/^vcs-stream-row-/u);
        const reader = IntersectionObserverStub.instances
          .reverse()
          .find((instance) => instance.options?.rootMargin === PATCH_ROOT_MARGIN)!;
        // Three rows are near the reader; four hundred are not. The rows that
        // are not used to be swept into the request as "overscan", so this is
        // the difference between three paths and four hundred.
        const near = new Set(["bulk/file-0000.txt", "bulk/file-0001.txt", "bulk/file-0002.txt"]);
        reader.report((element) => near.has(element.dataset.path ?? ""));
        await waitFor(() => expect(batchCalls(slot).length).toBeGreaterThan(0));
        const asked = batchCalls(slot).flatMap((call) => call.paths);
        expect(asked.length).toBeLessThanOrEqual(near.size);
        expect(new Set(asked)).toEqual(near);
        // And every call is still within the host's per-call cap.
        for (const call of batchCalls(slot)) expect(call.paths.length).toBeLessThanOrEqual(50);
      } finally {
        restore();
        delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
      }
    });
  });
});

describe("opening the commit panel", () => {
  it("opens it from the popup's Commit row and straight from a palette request", async () => {
    const user = userEvent.setup();
    const opened: { actionId: string; title?: string }[] = [];
    const slot = render({
      openThreadPanel: (options) => {
        opened.push({ actionId: options.actionId, title: options.title });
        return true;
      },
    });
    await user.click(slot.getByTestId("vcs-branch-button"));
    const popup = await screen.findByTestId("vcs-branch-popup");
    await user.click(await within(popup).findByText("Commit..."));
    await waitFor(() => expect(opened).toEqual([{ actionId: "commit", title: "Commit" }]));
    await waitFor(() => expect(screen.queryByTestId("vcs-branch-popup")).toBeNull());
    act(() => requestOpen({ threadId: "t1", action: "commit" }));
    await waitFor(() => expect(opened).toHaveLength(2));
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-branch-popup")).toBeNull();
  });
});

describe("LogPanel", () => {
  type LogRpc = Record<string, (input: never) => unknown>;

  const commit = (extra: Partial<LogCommit> = {}): LogCommit => ({
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    author: "Costa",
    committedAt: 1_700_000_000,
    subject: "a change",
    refs: [
      { kind: "head", name: "HEAD" },
      { kind: "local", name: "main" },
    ],
    parents: ["b".repeat(40)],
    ...extra,
  });

  const DETAILS = {
    ok: true as const,
    commit: {
      ...commit(),
      authorEmail: "costa@example.com",
      authoredAt: 1_700_000_000,
      committer: "Costa",
      committerEmail: "costa@example.com",
      message: "a change\n\nWhy it changed.",
    },
    files: [{ path: "a.txt", oldPath: null, additions: 2, deletions: 1, binary: false }],
    truncated: false,
    againstParent: "b".repeat(40),
  };

  function renderLogPanel(options: { params?: Record<string, unknown>; rpc?: LogRpc; overview?: Overview; openThreadPanel?: (options: { actionId: string; title?: string; params?: unknown }) => boolean } = {}) {
    const view = options.overview ?? overview();
    const panel = app.threadPanelActions.find((action) => action.id === "log")!;
    return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      panel,
      { threadId: "t1", params: (options.params ?? {}) as never },
      {
        sidebarThreads: sidebarThread({ id: "env1", branchName: "main" }),
        settings: { updateStrategy: "ff-only", autoStash: false, confirmBeforePush: true, defaultRemote: "origin", fetchPrune: true },
        ...(options.openThreadPanel ? { openThreadPanel: options.openThreadPanel } : {}),
        rpc: {
          overview: () => view,
          log: () => ({ ok: true, commits: [commit(), commit({ sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "Merge branch 'x'", refs: [], parents: ["c".repeat(40), "d".repeat(40)] })], skip: 0, hasMore: false }),
          commitDetails: () => DETAILS,
          commitPatch: (input: { path: string }) => ({ ok: true, path: input.path, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false, binary: false, contents: null }),
          cherryPick: () => ({ ok: true, message: "Cherry-picked aaaaaaa.", overview: view }),
          revert: () => ({ ok: true, message: "Reverted aaaaaaa.", overview: view }),
          resetTo: () => ({ ok: true, message: "Reset main to aaaaaaa (--hard).", overview: view }),
          createBranch: () => ({ ok: true, message: "Created.", overview: view }),
          checkoutRevision: () => ({ ok: true, message: "Checked out.", overview: view }),
          jobGet: () => null,
          jobCancel: () => ({ cancelled: true }),
          ...options.rpc,
        } as never,
      },
    );
  }

  const openCommitMenu = async (slot: { container: HTMLElement }, sha: string) => {
    const row = slot.container.querySelector(`[data-sha="${sha}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`no row for ${sha}`);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    return screen.findByTestId("vcs-commit-menu");
  };

  it("lists commits with their ref badges and reads the log once", async () => {
    const slot = renderLogPanel();
    await slot.findByText("a change");
    expect(slot.getByText("Merge branch 'x'")).toBeTruthy();
    expect(slot.getByTestId("vcs-log-count").textContent).toBe("2");
    const badges = Array.from(slot.container.querySelectorAll("[data-ref-kind]")).map((node) => [node.getAttribute("data-ref-kind"), node.textContent]);
    expect(badges).toEqual([
      ["head", "HEAD"],
      ["local", "main"],
    ]);
    const reads = slot.inspection.rpcCalls.filter((call) => call.method === "log");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.input).toEqual({ threadId: "t1", filter: { kind: "all" }, grep: null, skip: 0 });
  });

  it("opens the tab on a branch when the popup asked for one", async () => {
    const slot = renderLogPanel({ params: { filter: { kind: "ref", ref: { kind: "local", name: "feature" } } } });
    await slot.findByText("a change");
    expect(slot.inspection.rpcCalls.find((call) => call.method === "log")?.input).toMatchObject({ filter: { kind: "ref", ref: { kind: "local", name: "feature" } } });
    // The branch filter is a Radix Select now: it renders the option's label,
    // not a native <select> whose `.value` carries the raw option value.
    expect(slot.getByTestId("vcs-log-filter").textContent).toContain("feature");
    const ignored = renderLogPanel({ params: { filter: { kind: "ref", ref: { kind: "local", name: "-bad" } } } });
    await ignored.findByText("a change");
    expect(ignored.inspection.rpcCalls.find((call) => call.method === "log")?.input).toMatchObject({ filter: { kind: "all" } });
  });

  it("reads again for a branch filter and for a message filter", async () => {
    const user = userEvent.setup();
    const slot = renderLogPanel();
    await slot.findByText("a change");
    // Drive the Radix Select the way a pointer does: open it, then pick a row.
    await user.click(slot.getByTestId("vcs-log-filter"));
    await user.click(await slot.findByRole("option", { name: "Current branch" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "log")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ filter: { kind: "head" } });
    await user.type(slot.getByTestId("vcs-log-search"), "fix");
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ grep: "fix" }), { timeout: 2_000 });
  });

  it("shows the selected commit, its files and one file's diff", async () => {
    const user = userEvent.setup();
    const slot = renderLogPanel();
    await user.click(await slot.findByText("a change"));
    await slot.findByTestId("vcs-log-details");
    expect(slot.getByTestId("vcs-log-sha").textContent).toBe("a".repeat(40));
    expect(slot.getByText(/Why it changed/u)).toBeTruthy();
    await user.click(slot.getByText("a.txt"));
    await slot.findByTestId("vcs-patch");
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({
      method: "commitPatch",
      input: { threadId: "t1", sha: "a".repeat(40), path: "a.txt", oldPath: null },
    });
    await user.click(slot.getByTestId("vcs-log-back"));
    await slot.findByTestId("vcs-log-details");
  });

  it("asks with the exact command before a cherry-pick, a revert and a reset", async () => {
    const user = userEvent.setup();
    const sha = "a".repeat(40);
    const slot = renderLogPanel();
    await slot.findByText("a change");

    const menu = await openCommitMenu(slot, sha);
    await user.click(within(menu).getByText("Cherry-Pick"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git cherry-pick --end-of-options ${sha}`);
    await user.click(screen.getByText("Cherry-pick", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "cherryPick", input: { threadId: "t1", sha } }));

    const again = await openCommitMenu(slot, sha);
    await user.click(within(again).getByText("Revert Commit"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git revert --no-edit --end-of-options ${sha}`);
    await user.click(screen.getByText("Revert", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "revert", input: { threadId: "t1", sha } }));

    const third = await openCommitMenu(slot, sha);
    // Radix opens a submenu on pointer move, which userEvent's hover sends.
    await user.hover(within(third).getByText("Reset Current Branch to Here..."));
    // A plain click: Radix's submenu items swallow userEvent's pointer
    // sequence under jsdom.
    fireEvent.click(await screen.findByText("Hard"));
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git reset --hard --end-of-options ${sha} --`);
    await user.click(screen.getByText("Reset --hard", { selector: "button" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "resetTo", input: { threadId: "t1", sha, mode: "hard" } }));
  });

  it("ignores the release of the right-click that opened the menu", async () => {
    const slot = renderLogPanel();
    await slot.findByText("a change");
    const menu = await openCommitMenu(slot, "a".repeat(40));
    const checkout = within(menu).getByText("Checkout Revision");
    // Radix clicks an item on a pointerup it saw no pointerdown for, which is
    // the release of the right-click when the menu opened under the pointer.
    fireEvent.pointerUp(checkout);
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByTestId("vcs-command-preview")).toBeNull();
    // A real click still opens the confirm dialog with its command.
    fireEvent.click(checkout);
    expect((await screen.findByTestId("vcs-command-preview")).textContent).toBe(`git switch --detach --end-of-options ${"a".repeat(40)}`);
  });

  it("refuses to cherry-pick or revert a merge commit", async () => {
    const slot = renderLogPanel();
    await slot.findByText("Merge branch 'x'");
    const menu = await openCommitMenu(slot, "b".repeat(40));
    expect(within(menu).getByText("Cherry-Pick").getAttribute("data-disabled")).not.toBeNull();
    expect(within(menu).getByText("Revert Commit").getAttribute("data-disabled")).not.toBeNull();
    expect(within(menu).getByText("Copy Revision Number").getAttribute("data-disabled")).toBeNull();
  });

  it("creates a branch from a commit and opens the compare tab against the current branch", async () => {
    const user = userEvent.setup();
    const sha = "a".repeat(40);
    const opened: { actionId: string; params?: unknown }[] = [];
    const slot = renderLogPanel({
      openThreadPanel: (options) => {
        opened.push({ actionId: options.actionId, params: options.params });
        return true;
      },
    });
    await slot.findByText("a change");

    const menu = await openCommitMenu(slot, sha);
    await user.click(within(menu).getByText("New Branch from 'aaaaaaa'..."));
    await user.type(await screen.findByLabelText("New branch name"), "from-log");
    await user.click(screen.getByText("Create", { selector: "button" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({
        method: "createBranch",
        input: { threadId: "t1", name: "from-log", startPoint: sha, checkout: true },
      }),
    );

    const again = await openCommitMenu(slot, sha);
    await user.click(within(again).getByText("Compare with 'main'"));
    await waitFor(() =>
      expect(opened).toEqual([
        { actionId: "compare", params: { base: { kind: "local", name: "main" }, target: { kind: "revision", revision: sha } } },
      ]),
    );
  });

  it("reports a git failure and an empty log without pretending to have rows", async () => {
    const failing = renderLogPanel({ rpc: { log: () => ({ ok: false, error: { code: "git_failed", message: "log failed", hint: "try again" } }) } });
    expect(await failing.findByText("log failed")).toBeTruthy();
    expect(failing.getByText("try again")).toBeTruthy();
    const empty = renderLogPanel({ rpc: { log: () => ({ ok: true, commits: [], skip: 0, hasMore: false }) } });
    expect(await empty.findByText("No commit yet.")).toBeTruthy();
  });

  it("loads the next page and keeps the rows it already has", async () => {
    const user = userEvent.setup();
    let call = 0;
    const slot = renderLogPanel({
      rpc: {
        log: () => {
          call += 1;
          return call === 1
            ? { ok: true, commits: [commit()], skip: 0, hasMore: true }
            : { ok: true, commits: [commit(), commit({ sha: "c".repeat(40), shortSha: "ccccccc", subject: "older", refs: [], parents: [] })], skip: 1, hasMore: false };
        },
      },
    });
    await slot.findByText("a change");
    await user.click(slot.getByTestId("vcs-log-more"));
    await slot.findByText("older");
    // The repeated commit arrives once.
    expect(slot.container.querySelectorAll(`[data-sha="${"a".repeat(40)}"]`)).toHaveLength(1);
    expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({ skip: 1 });
  });
});

describe("settings sections", () => {
  function renderSettings(id: string, rpc: Record<string, unknown> = {}) {
    const section = app.settingsSections.find((entry) => entry.id === id)!;
    return renderSlot<Record<string, never>, typeof rpcContract>(section, {}, { rpc: rpc as never });
  }

  it("registers both sections with a heading of their own", () => {
    expect(app.settingsSections.map((section) => section.id)).toEqual(["agent-access", "favourites"]);
    expect(app.settingsSections[0]?.title).toBe("Agent access");
  });

  it("names the read-only surfaces an agent can reach", () => {
    const slot = renderSettings("agent-access");
    expect(slot.getByText("bb vcs-widget status")).toBeTruthy();
    expect(slot.getByText("vcs_widget_status")).toBeTruthy();
    expect(slot.container.textContent).toContain("Both only read");
  });

  it("says where favourites come from when there are none", async () => {
    const slot = renderSettings("favourites", { favouriteRepos: () => ({ repos: [] }) });
    expect(await slot.findByText(/No favourites yet/u)).toBeTruthy();
  });

  it("lists a repository's favourites and clears them", async () => {
    const user = userEvent.setup();
    let repos = [{ hostId: "h1", repoRoot: "/repo", names: ["local:main", "remote:origin/feature"] }];
    const slot = renderSettings("favourites", {
      favouriteRepos: () => ({ repos }),
      clearFavourites: (input: { hostId: string; repoRoot: string }) => {
        repos = repos.filter((repo) => repo.hostId !== input.hostId || repo.repoRoot !== input.repoRoot);
        return { repos };
      },
    });
    expect(await slot.findByText("/repo")).toBeTruthy();
    // The stored key is `local:main`; the row shows the branch.
    expect(slot.getByText("main")).toBeTruthy();
    expect(slot.getByText("origin/feature")).toBeTruthy();
    await user.click(slot.getByRole("button", { name: "Clear" }));
    expect(await slot.findByText(/No favourites yet/u)).toBeTruthy();
    expect(slot.inspection.rpcCalls.at(-1)).toMatchObject({ method: "clearFavourites", input: { hostId: "h1", repoRoot: "/repo" } });
  });
});

describe("composer banner", () => {
  const banner = () => app.composerCustomizations[0]!.banners![0]!;

  function renderBanner(options: { overview?: Overview; environment?: { id: string; branchName: string } | null; rpc?: Partial<Rpc> } = {}) {
    const view = options.overview ?? overview({ workingTree: { staged: 1, unstaged: 0, untracked: 2, conflicted: 0 } });
    return renderSlot<Record<string, never>, typeof rpcContract>(
      banner(),
      {},
      {
        composer: { scope: { kind: "thread", threadId: "t1" } },
        sidebarThreads: sidebarThread(options.environment === undefined ? { id: "env1", branchName: "main" } : options.environment),
        rpc: { overview: () => view, sendToAgent: () => ({ ok: true, delivery: "sent" }), ...options.rpc } as never,
      },
    );
  }

  const calls = (slot: { inspection: { rpcCalls: { method: string; input: unknown }[] } }, method: string) =>
    slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

  it("only takes over a thread's composer", () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(app.composerCustomizations[0]!.scopes).toEqual(["thread"]);
  });

  it("says where you are and how much there is, counting untracked files", async () => {
    const slot = renderBanner();
    expect(await slot.findByTestId("vcs-composer-banner")).toBeTruthy();
    expect(slot.getByText("main")).toBeTruthy();
    // A new file is something to commit, so the count is not the one a
    // checkout would ask about.
    expect(slot.getByText("3 to commit")).toBeTruthy();
    expect(slot.getByTitle("1 staged, 2 untracked")).toBeTruthy();
  });

  it("stays off a clean tree, having read it", async () => {
    const slot = renderBanner({ overview: overview() });
    await waitFor(() => expect(calls(slot, "overview")).toEqual([{ threadId: "t1" }]));
    expect(screen.queryByTestId("vcs-composer-banner")).toBeNull();
  });

  it("reads nothing on a thread with no environment", async () => {
    const slot = renderBanner({ environment: null });
    // The overview read goes out with the mount effect, so one flush is enough
    // to catch it.
    await act(async () => {});
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(screen.queryByTestId("vcs-composer-banner")).toBeNull();
  });

  it("sends both agent actions, and quotes what went rather than the button", async () => {
    const user = userEvent.setup();
    const sent = vi.spyOn(toast, "success").mockImplementation(() => "");
    const slot = renderBanner({ rpc: { sendToAgent: () => ({ ok: true, delivery: "queued" }) } });
    const commit = (await slot.findByTestId("vcs-composer-commit-button")) as HTMLButtonElement;
    expect(commit.textContent).toBe("Agent Commit");
    await user.click(commit);
    await waitFor(() => expect(calls(slot, "sendToAgent")).toEqual([{ threadId: "t1", variant: "commit" }]));
    expect(sent.mock.calls.at(-1)?.[0]).toContain("LGTM - Commit");
    expect(sent.mock.calls.at(-1)?.[0]).toContain("queued");

    const push = slot.getByTestId("vcs-composer-commit-push-button") as HTMLButtonElement;
    expect(push.textContent).toBe("Agent Commit & Push");
    await user.click(push);
    await waitFor(() =>
      expect(calls(slot, "sendToAgent")).toEqual([
        { threadId: "t1", variant: "commit" },
        { threadId: "t1", variant: "commit-push" },
      ]),
    );
    expect(sent.mock.calls.at(-1)?.[0]).toContain("LGTM - Commit & Push");
  });

  it("reports an agent it could not reach", async () => {
    const user = userEvent.setup();
    const failed = vi.spyOn(toast, "error").mockImplementation(() => "");
    const slot = renderBanner({
      rpc: { sendToAgent: () => ({ ok: false, error: { code: "git_failed", message: "The message did not reach the agent: no such thread" } }) },
    });
    await user.click(await slot.findByTestId("vcs-composer-commit-button"));
    await waitFor(() => expect(failed.mock.calls.at(-1)?.[0]).toContain("did not reach the agent"));
  });
});
