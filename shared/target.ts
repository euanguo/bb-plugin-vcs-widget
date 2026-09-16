// What the commit panel's diff pane is pointed at.
//
// The panel has always shown the working tree: HEAD to index on one side,
// index to working tree on the other, both stacked in one stream. These are
// the other two answers bb's own diff panel offers -- the commits this branch
// holds that a base branch does not, and any one of them -- modelled as one
// value so the pane, the file list and the picker cannot disagree about what
// is on screen.
import type { Commit, CompareRef, DiffTarget, Overview } from "../contracts";
import type { DiffSide } from "./constants";
import { refLabel } from "./model";

/**
 * The working tree, a range of commits, or one commit.
 *
 * A range deliberately does not carry its base: the base is chosen in a
 * second control and changes while the range stays selected, so holding a copy
 * inside the target would leave the pane reading a branch the picker no longer
 * names.
 */
export type PanelTarget = { kind: "uncommitted" } | { kind: "commits" } | { kind: "commit"; sha: string };

/**
 * Which reader answers for a row. The two index sides are their own channel
 * because a batch read names exactly one side; every other target is one
 * channel, because a commit or a range has no second side to read.
 */
export type DiffChannel = DiffSide | "target";

export const UNCOMMITTED: PanelTarget = { kind: "uncommitted" };

/** A target as a stable string, for keys, tests and stored preferences. */
export function targetKey(target: PanelTarget): string {
  if (target.kind === "uncommitted") return "uncommitted";
  if (target.kind === "commit") return `commit:${target.sha}`;
  return "commits";
}

/** A ref as a string that survives localStorage and can be parsed back. */
export function parseTargetKey(key: string): PanelTarget | null {
  if (key === "uncommitted") return UNCOMMITTED;
  if (key.startsWith("commit:")) {
    const sha = key.slice("commit:".length);
    return sha.length === 0 ? null : { kind: "commit", sha };
  }
  if (key === "commits") return { kind: "commits" };
  return null;
}

/** A ref as a string that survives localStorage and can be parsed back. */
export function compareRefKey(ref: CompareRef): string {
  if (ref.kind === "local") return `local:${ref.name}`;
  if (ref.kind === "remote") return `remote:${ref.remote}/${ref.branch}`;
  return `revision:${ref.revision}`;
}

/**
 * The ref `compareRefKey` wrote back. Null for anything that does not parse,
 * so a stored preference from an older build is ignored rather than trusted.
 */
export function parseCompareRef(key: string): CompareRef | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (rest.length === 0) return null;
  if (kind === "local") return { kind: "local", name: rest };
  if (kind === "revision") return { kind: "revision", revision: rest };
  if (kind === "remote") {
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) return null;
    return { kind: "remote", remote: rest.slice(0, slash), branch: rest.slice(slash + 1) };
  }
  return null;
}

/**
 * The branch a range is measured from when the reader has not said otherwise.
 *
 * The upstream first, because that is the branch this work is going to land
 * on and what "my commits" almost always means. Failing that, main or master,
 * preferring a remote-tracking one -- a stale local main is the wrong
 * comparison. Failing that, any other branch, which at least gives the picker
 * something selected.
 */
export function defaultBase(overview: Overview | null): CompareRef | null {
  if (overview === null || overview.unavailableReason !== null) return null;
  const upstream = overview.upstream;
  if (upstream !== null && upstream.remote !== null && upstream.branch !== null && !upstream.gone) {
    return { kind: "remote", remote: upstream.remote, branch: upstream.branch };
  }
  const current = overview.head?.kind === "branch" ? overview.head.name : null;
  for (const name of ["main", "master"]) {
    if (name !== current && overview.local.some((branch) => branch.name === name)) return { kind: "local", name };
  }
  for (const remote of overview.remotes) {
    for (const name of ["main", "master"]) {
      if (overview.remote.some((branch) => branch.remote === remote && branch.name === name)) {
        return { kind: "remote", remote, branch: name };
      }
    }
  }
  const other = overview.local.find((branch) => branch.name !== current);
  return other === undefined ? null : { kind: "local", name: other.name };
}

/** Every branch a range could be measured from, current one excluded. */
export function baseCandidates(overview: Overview | null): CompareRef[] {
  if (overview === null || overview.unavailableReason !== null) return [];
  const current = overview.head?.kind === "branch" ? overview.head.name : null;
  const local = overview.local.filter((branch) => branch.name !== current).map((branch): CompareRef => ({ kind: "local", name: branch.name }));
  // `name` is the short display name ("origin/main"); `branch` is the branch
  // itself, which is what a ref is built from.
  const remote = overview.remote.map((branch): CompareRef => ({ kind: "remote", remote: branch.remote, branch: branch.branch }));
  return [...local, ...remote];
}

/** The line the picker shows for the current target. */
export function targetLabel(target: PanelTarget, base: CompareRef | null, commits: readonly Commit[]): string {
  if (target.kind === "uncommitted") return "Uncommitted changes";
  if (target.kind === "commit") {
    const match = commits.find((commit) => commit.sha === target.sha);
    return match === undefined ? target.sha.slice(0, 7) : match.subject;
  }
  return base === null ? "All commits" : `All commits vs ${refLabel(base)}`;
}

/** The channels a target's stream rows belong to, in row order. */
export function channelsFor(target: PanelTarget): DiffChannel[] {
  return target.kind === "uncommitted" ? ["index", "worktree"] : ["target"];
}
