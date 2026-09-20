// Values the browser bundle needs that must not drag zod (contracts.ts) or
// server code into app.js. contracts.ts and server/* import from here too.

export const PULL_STRATEGIES = ["ff-only", "rebase", "merge"] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];

export function isPullStrategy(value: unknown): value is PullStrategy {
  return typeof value === "string" && (PULL_STRATEGIES as readonly string[]).includes(value);
}

/** Realtime channel the app listens on; payload `{ environmentId?, hostId?, reason }`. */
export const CHANGED_CHANNEL = "changed";

export interface ChangedPayload {
  /** Absent when the server cannot map the change to an environment (everyone refetches). */
  environmentId?: string;
  hostId?: string;
  reason: string;
}

/** Realtime channel for background job progress; payload is a `JobRealtimePayload`. */
export const JOB_CHANNEL = "job";

/**
 * Host work that runs as a background job instead of inside one host call:
 * network operations, and commit because hooks can take longer than 30 s.
 */
export const JOB_KINDS = ["fetch", "pull", "push", "updateBranch", "deleteRemoteBranch", "commit"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

/** Default and bounds of the `jobTimeoutSeconds` setting. */
export const JOB_TIMEOUT_SECONDS = { default: 600, min: 30, max: 3600 } as const;

/** Paths per stage / unstage / discard call, and the bytes they may add up to (argv, not stdin). */
export const MAX_PATHS_PER_CALL = 500;
export const MAX_PATH_BYTES_PER_CALL = 256 * 1024;

/** What one path list costs on argv: the path plus its NUL separator. */
export function pathListBytes(paths: readonly string[]): number {
  return paths.reduce((total, path) => total + path.length + 1, 0);
}

/**
 * Whether a path list fits one call, by the same two caps the contract
 * enforces. The app asks before it offers a whole-group action, so a discard
 * of hundreds of long paths says so instead of failing validation.
 */
export function fitsPathList(paths: readonly string[]): boolean {
  return paths.length <= MAX_PATHS_PER_CALL && pathListBytes(paths) <= MAX_PATH_BYTES_PER_CALL;
}
/** A commit message travels as one RPC string and then on git's stdin. */
export const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
/** Changed files listed by the commit panel. */
export const CHANGES_LIMIT = 500;

/**
 * Rows of the commit panel's changed-file list are a fixed height too, so the
 * file list can be windowed the same way the log and the popup are. A
 * directory header and a file row are both one line.
 */
export const CHANGE_LIST_ROW_HEIGHT = 22;

/** Rows kept on either side of the file list's viewport. */
export const CHANGE_LIST_WINDOW_OVERSCAN = 8;

/**
 * How wide the changed-file pane may be dragged. IntelliJ's own commit dialog
 * has about this range, and the panel is a side tab rather than the window.
 */
export const PANE_WIDTH = { min: 220, max: 520 } as const;

/**
 * The branch popup's rows are a fixed height so the list can be windowed
 * without measuring, the way the log's are. Every row — a group heading, a
 * quick action or a branch — is pinned to exactly this, and the rows live
 * directly in the list rather than inside cmdk groups, whose `p-1` fighting
 * the arithmetic is what would make the scrollbar lie.
 */
export const POPUP_ROW_HEIGHT = 32;

/**
 * Rows kept on either side of the popup's viewport while scrolling. Smaller
 * than the log's: a branch row is cheap to build but the whole point here is
 * that only a screenful exists at a time.
 */
export const POPUP_WINDOW_OVERSCAN = 6;

/** Commits per log page; the host reads one more to learn whether another page exists. */
export const LOG_PAGE_SIZE = 100;
/** How far "Load more" may walk with `--skip`. */
export const LOG_MAX_SKIP = 10_000;
/** Longest message filter the log accepts; it travels as one `--grep` argument. */
export const MAX_LOG_GREP_LENGTH = 200;
/** Log rows are a fixed height so the list can be virtualised without measuring. */
export const LOG_ROW_HEIGHT = 26;

/** How `git reset` moves the current branch: index and worktree, index only, neither. */
export const RESET_MODES = ["soft", "mixed", "hard"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** Which side of a change a file diff shows: HEAD → index, or index → working tree. */
export const DIFF_SIDES = ["index", "worktree"] as const;
export type DiffSide = (typeof DIFF_SIDES)[number];

/**
 * The commit panel's two agent buttons: what each one says to the human and
 * what it sends to the thread's agent, as if the human had typed it.
 *
 * The messages are fixed and the caller names a variant, never the text —
 * these two lines are the whole of what the plugin can say to an agent, and
 * a repository that needs other words is a setting for later. Label and
 * message differ on purpose: the button is read beside "Commit" and
 * "Commit and Push", where "Agent" is the word that separates them, while
 * the message is read in the thread's transcript, where "LGTM - Commit"
 * carries the human's verdict along with the instruction.
 */
export const AGENT_ACTIONS = {
  commit: { label: "Agent Commit", message: "LGTM - Commit" },
  "commit-push": { label: "Agent Commit & Push", message: "LGTM - Commit & Push" },
} as const;

export type AgentActionVariant = keyof typeof AGENT_ACTIONS;

/** The variants in button order, so the contract and the panel cannot drift. */
export const AGENT_ACTION_VARIANTS = ["commit", "commit-push"] as const satisfies readonly AgentActionVariant[];

/** `git switch` and `--end-of-options` arrived in 2.24. */
export const MIN_GIT_VERSION = { major: 2, minor: 24 } as const;

/**
 * Paths per batch diff read. Matches bb's own per-request cap so one page of
 * the continuous stream can never ask for more than a host call handles.
 */
export const DIFF_PATCH_MAX_PATHS_PER_REQUEST = 50;

/**
 * How far past the viewport a diff card is read for. This margin *is* the
 * read-ahead: everything the observer reports inside it is asked for, and
 * nothing outside it is, so the set of paths one open can request is bounded
 * by the viewport plus this band rather than by the size of the change set.
 * Was 200px, which read barely past the fold; widening it here replaced the
 * separate unbounded "overscan" list that used to carry the read-ahead.
 */
export const PATCH_ROOT_MARGIN = "600px 0px";

/**
 * How long a pane resize has to be quiet before the diff content is allowed to
 * lay itself out again. A wrapping diff is laid out as a grid whose columns
 * span every row, so each width change makes the browser re-wrap all of it and
 * re-solve that grid — measured at about 180ms a frame, against 0-1ms with
 * `overflow: scroll`. Pinning the content width for the length of a drag turns
 * that into one relayout when the drag ends.
 */
export const DIFF_WRAP_PIN_SETTLE_MS = 160;

/**
 * How long a repository read stays good enough to paint from. Reopening the
 * popup inside this window shows the overview already in hand instead of
 * waiting on a host round trip; `changed` signals and a reconnect still force
 * a read, so a lock or an external checkout is never more than a few seconds
 * from being seen.
 */
export const OVERVIEW_FRESH_MS = 2_000;

/**
 * Image extensions the panel previews instead of saying "Binary file.".
 *
 * Deliberately the same set bb's own diff panel previews, so a file shows a
 * picture in one panel and a notice in the other only where the format really
 * is not renderable. SVG is absent on purpose: it is text, so the diff itself
 * is the more useful view.
 */
export const PREVIEWABLE_IMAGE_MIME: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** The image's MIME type, or null when the path is not a previewable image. */
export function previewableImageMime(path: string | null | undefined): string | null {
  if (path === null || path === undefined) return null;
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null;
  return PREVIEWABLE_IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** One side of a binary file, as bytes the viewer can turn into a data URL. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
