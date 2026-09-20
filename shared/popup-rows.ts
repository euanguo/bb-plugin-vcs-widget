// The branch popup's rows as one flat list.
//
// The list is windowed, so it cannot be a tree of cmdk groups: the window is
// arithmetic over a fixed row height, and a group wrapper's own padding would
// put every row after it in the wrong place. Headings therefore travel as rows
// of the same height as everything else, and the popup renders the slice the
// window asks for.
//
// Two steps, because they answer to different clocks. `popupSource` wraps the
// overview's branches into entries once per repository read; `buildPopupRows`
// sorts and filters them once per keystroke. Keeping the wrapper behind its own
// step is what lets a keystroke reuse the same `BranchEntry` objects, which is
// what lets a memoized row keep its place while the reader types.
import type { Overview } from "../contracts";
import {
  FAVOURITE_BONUS,
  entryKey,
  filterAndRank,
  matchScore,
  quickActionsFor,
  type BranchEntry,
  type BranchGroups,
  type QuickAction,
} from "./model";

/** Which group a branch row belongs to; also the row key's prefix. */
export type PopupBranchPrefix = "fav" | "recent" | "local" | "remote";

export interface PopupHeadingRow {
  kind: "heading";
  key: string;
  label: string;
}

export interface PopupActionRow {
  kind: "action";
  key: string;
  action: QuickAction;
}

export interface PopupBranchRow {
  kind: "branch";
  key: string;
  prefix: PopupBranchPrefix;
  entry: BranchEntry;
}

export type PopupRow = PopupHeadingRow | PopupActionRow | PopupBranchRow;

/** Everything the popup lists, wrapped and in group order, before filtering. */
export interface PopupSource {
  actions: QuickAction[];
  favourites: BranchEntry[];
  recent: BranchEntry[];
  local: BranchEntry[];
  remote: BranchEntry[];
  /** The overview truncated one of the lists at the host's cap. */
  truncatedLocal: boolean;
  truncatedRemote: boolean;
}

export const EMPTY_POPUP_SOURCE: PopupSource = {
  actions: [],
  favourites: [],
  recent: [],
  local: [],
  remote: [],
  truncatedLocal: false,
  truncatedRemote: false,
};

/**
 * Wrap an overview into the popup's groups. Deliberately separate from
 * `buildPopupRows` and called from its own memo: this is where the
 * `BranchEntry` objects are made, and the reader typing a query must not make
 * new ones, or every row would lose its memo on every keystroke.
 */
export function popupSource(overview: Overview | null, groups: BranchGroups | null): PopupSource {
  // A popup with no overview yet shows its "reading" line, not a list.
  if (overview === null || groups === null) return EMPTY_POPUP_SOURCE;
  const asLocal = (branch: (typeof groups.local)[number]): BranchEntry => ({ kind: "local", branch });
  return {
    actions: quickActionsFor(overview),
    // The favourites group is already built from both kinds of entry.
    favourites: groups.favourites,
    recent: groups.recent.map(asLocal),
    local: groups.local.map(asLocal),
    remote: groups.remote.map((branch): BranchEntry => ({ kind: "remote", branch })),
    truncatedLocal: overview.truncated.local,
    truncatedRemote: overview.truncated.remote,
  };
}

const favouriteBonus =
  (favourites: ReadonlySet<string>) =>
  (entry: BranchEntry): number =>
    favourites.has(entryKey(entry)) ? FAVOURITE_BONUS : 0;

/** A branch entry as `filterAndRank` needs to see it: something with a name. */
interface NamedEntry {
  name: string;
  entry: BranchEntry;
}

function rankBranches(entries: readonly BranchEntry[], query: string, favourites: ReadonlySet<string>): BranchEntry[] {
  const named: NamedEntry[] = entries.map((entry) => ({ name: entry.branch.name, entry }));
  return filterAndRank(named, query, (item) => favouriteBonus(favourites)(item.entry)).map((item) => item.entry);
}

/**
 * The popup's rows for one query, in render order: quick actions, then
 * favourites, recent, local and remote. A heading is left out when its group
 * is empty, which is why the caller cannot compute row positions itself.
 */
export function buildPopupRows(
  source: PopupSource,
  query: string,
  favourites: ReadonlySet<string>,
): PopupRow[] {
  const rows: PopupRow[] = [];
  const heading = (key: string, label: string) => rows.push({ kind: "heading", key: `heading:${key}`, label });
  const branchRows = (prefix: PopupBranchPrefix, entries: readonly BranchEntry[]) => {
    for (const entry of entries) {
      rows.push({ kind: "branch", key: `${prefix}:${entryKey(entry)}`, prefix, entry });
    }
  };

  const actions = source.actions.filter((action) => matchScore(action.label, query) > 0);
  if (actions.length > 0) {
    heading("actions", "Actions");
    for (const action of actions) rows.push({ kind: "action", key: `action:${action.id}`, action });
  }

  const groups: { prefix: PopupBranchPrefix; label: string; entries: BranchEntry[] }[] = [
    { prefix: "fav", label: "Favourites", entries: source.favourites },
    { prefix: "recent", label: "Recent", entries: source.recent },
    { prefix: "local", label: source.truncatedLocal ? "Local (truncated)" : "Local", entries: source.local },
    { prefix: "remote", label: source.truncatedRemote ? "Remote (truncated)" : "Remote", entries: source.remote },
  ];
  for (const group of groups) {
    const entries = rankBranches(group.entries, query, favourites);
    if (entries.length === 0) continue;
    heading(group.prefix, group.label);
    branchRows(group.prefix, entries);
  }
  return rows;
}

/** Whether the arrow keys may land on a row. A heading is a label, not a target. */
export function rowSelectable(row: PopupRow): boolean {
  return row.kind !== "heading";
}

/** The first selectable row, or -1 when the list holds only headings. */
export function firstSelectable(rows: readonly PopupRow[]): number {
  return rows.findIndex(rowSelectable);
}

/** The last selectable row, or -1. */
export function lastSelectable(rows: readonly PopupRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rowSelectable(rows[index]!)) return index;
  }
  return -1;
}

/**
 * The next selectable row `delta` steps away, clamped at both ends so the
 * arrow keys stop rather than wrap. With nothing highlighted yet, down starts
 * at the top of the list and up at the bottom, which is what cmdk did.
 */
export function stepSelectable(rows: readonly PopupRow[], from: number, delta: 1 | -1): number {
  if (rows.length === 0) return -1;
  if (from < 0 || from >= rows.length || !rowSelectable(rows[from]!)) {
    return delta === 1 ? firstSelectable(rows) : lastSelectable(rows);
  }
  for (let index = from + delta; index >= 0 && index < rows.length; index += delta) {
    if (rowSelectable(rows[index]!)) return index;
  }
  return from;
}
