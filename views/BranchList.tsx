// The branch popup's rows, rendered as the window over them asks.
//
// The rows are one flat list — group headings are rows like any other — because
// the window is arithmetic over a fixed row height and a cmdk group's own
// padding would put every row after it in the wrong place. Each row is pinned
// to exactly `POPUP_ROW_HEIGHT` so that arithmetic holds.
import { memo } from "react";
import type { Overview } from "../contracts";
import type { BranchEntry, BranchMenuItemId, QuickAction, QuickActionId } from "../shared/model";
import { entryKey } from "../shared/model";
import type { PopupRow } from "../shared/popup-rows";
import type { VirtualWindow } from "../shared/virtual";
import { POPUP_ROW_HEIGHT } from "../shared/constants";
import { CommandItem, CommandShortcut } from "@/components/ui/command";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@/lib/utils";
import { BranchRow, type MenuExtra } from "./BranchRow";

/** IntelliJ's own glyphs for the quick actions. */
const ACTION_ICONS: Record<QuickActionId, IconName> = {
  update: "ArrowDown",
  commit: "Check",
  log: "Clock",
  fetch: "ArrowReloadHorizontal",
  push: "ArrowUp",
  "new-branch": "Plus",
  "checkout-revision": "TimeSchedule",
};

/** A group's name, as a row of the same height as everything else. */
const HEADING_CLASS = "flex items-center px-2 text-xs font-medium text-muted-foreground";

export interface BranchListProps {
  rows: readonly PopupRow[];
  window: VirtualWindow;
  overview: Overview | null;
  /** An operation or a job blocks the repository: a row explains instead of running. */
  disabled: boolean;
  favourites: ReadonlySet<string>;
  onSelect: (entry: BranchEntry) => void;
  onMenu: (itemId: BranchMenuItemId, entry: BranchEntry, extra?: MenuExtra) => void;
  onAction: (id: QuickActionId) => void;
}

/**
 * The slice of the list the window covers, between two spacers that hold the
 * space of the rows not in the DOM. `overview` is non-null for every branch
 * row here: the popup only builds rows once it has one.
 */
export function BranchListRows({ rows, window, overview, disabled, favourites, onSelect, onMenu, onAction }: BranchListProps) {
  const visible = rows.slice(window.start, window.end);
  return (
    <>
      <div style={{ height: window.topPadding }} aria-hidden data-testid="vcs-popup-spacer-top" />
      {visible.map((row) => {
        if (row.kind === "heading") {
          return (
            <div key={row.key} className={HEADING_CLASS} style={{ height: POPUP_ROW_HEIGHT }} data-testid={`vcs-popup-heading-${row.key}`}>
              {row.label}
            </div>
          );
        }
        if (row.kind === "action") {
          return <ActionRow key={row.key} row={row} disabled={disabled} onAction={onAction} />;
        }
        return (
          <BranchRow
            key={row.key}
            value={row.key}
            entry={row.entry}
            overview={overview!}
            disabled={disabled}
            favourite={favourites.has(entryKey(row.entry))}
            onSelect={onSelect}
            onMenu={onMenu}
          />
        );
      })}
      <div style={{ height: window.bottomPadding }} aria-hidden data-testid="vcs-popup-spacer-bottom" />
    </>
  );
}

interface ActionRowProps {
  row: Extract<PopupRow, { kind: "action" }>;
  disabled: boolean;
  onAction: (id: QuickActionId) => void;
}

/**
 * A quick action. `data-action` is what a live check clicks, so it stays on the
 * row itself rather than on a wrapper.
 */
const ActionRow = memo(function ActionRow({ row, disabled, onAction }: ActionRowProps) {
  const action: QuickAction = row.action;
  return (
    <CommandItem
      value={row.key}
      disabled={disabled || action.disabled}
      onSelect={() => onAction(action.id)}
      title={action.reason ?? undefined}
      data-action={action.id}
      className="gap-2 pr-1"
      style={{ height: POPUP_ROW_HEIGHT }}
    >
      <Icon name={ACTION_ICONS[action.id]} className={cn("size-3.5 text-muted-foreground")} />
      <span className="flex-1 truncate">{action.label}</span>
      {action.hint ? <CommandShortcut>{action.hint}</CommandShortcut> : null}
    </CommandItem>
  );
});
