// The branch popup's window: which slice of its rows is in the DOM.
//
// cmdk keeps the keyboard. It has to: its arrow keys, Home/End, Enter and its
// `aria-activedescendant` all read the items it can see in the DOM, and they
// are updated by its own store, not by the `value` prop — setting that prop
// from outside moves the highlight but leaves `aria-activedescendant` stale,
// which is worse than a slow list. So this hook owns exactly one thing: how
// many rows exist. cmdk keeps working because the row one arrow press away is
// always rendered: it moves the selection inside the viewport, that scrolls
// the container, and the window follows the scroll.
//
// That leaves two places where "what cmdk can see" and "what the list holds"
// disagree, and both are handled here rather than by taking the keyboard over.
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { POPUP_ROW_HEIGHT, POPUP_WINDOW_OVERSCAN } from "../shared/constants";
import { firstSelectable, lastSelectable, type PopupRow } from "../shared/popup-rows";
import { visibleRange, type VirtualWindow } from "../shared/virtual";

/** cmdk's own query for the items it can move between. */
const ITEM_SELECTOR = '[cmdk-item=""]:not([aria-disabled="true"])';

export interface PopupList {
  /**
   * Goes on cmdk's list element. A callback ref rather than an object ref
   * because the popup is mounted from the start while its content is not: the
   * container only exists once the popover opens, and the height has to be
   * measured when it does.
   */
  listRef: (element: HTMLDivElement | null) => void;
  /** The same container, for the handlers the popup runs outside this hook. */
  listElement: HTMLDivElement | null;
  window: VirtualWindow;
  onScroll: () => void;
  /**
   * Goes on the cmdk root's `onKeyDown`, which runs before cmdk's own handler
   * and is skipped by it whenever the event was default-prevented.
   */
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function usePopupList(rows: readonly PopupRow[], query: string): PopupList {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const listRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    setListElement(element);
  }, []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // A Home or End that has moved the scroll but has not yet been handed to
  // cmdk, because the row it asks for is only rendered after that scroll.
  const [edgeJump, setEdgeJump] = useState<"first" | "last" | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const window = visibleRange({
    scrollTop,
    viewportHeight,
    rowHeight: POPUP_ROW_HEIGHT,
    count: rows.length,
    overscan: POPUP_WINDOW_OVERSCAN,
  });

  const onScroll = useCallback(() => {
    setScrollTop(elementRef.current?.scrollTop ?? 0);
  }, []);

  // The container's own height, so the window can be a screenful without
  // measuring a row.
  useLayoutEffect(() => {
    if (listElement === null) return;
    const measure = () => setViewportHeight(listElement.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(listElement);
    return () => observer.disconnect();
  }, [listElement]);

  // A new query is a new list, and the reader is looking at its top. Done in a
  // layout effect so the window has already moved by the time cmdk picks the
  // first item to highlight.
  const lastQuery = useRef(query);
  useLayoutEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setScrollTop(0);
    if (elementRef.current !== null) elementRef.current.scrollTop = 0;
  }, [query]);

  const selectedIndex = useCallback((): number => {
    const element = elementRef.current?.querySelector('[cmdk-item][aria-selected="true"]');
    const value = element?.getAttribute("data-value");
    if (value === null || value === undefined) return -1;
    return rowsRef.current.findIndex((row) => row.key === value);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const list = elementRef.current;
      if (list === null) return;

      if (event.key === "Home" || event.key === "End") {
        // cmdk's own Home/End take the first and last item *it can see*, which
        // with a window is the edge of the window. Scroll to the real edge
        // first and hand the move over below, once that edge is rendered.
        //
        // The offset is arithmetic rather than `scrollHeight`, which would
        // need a laid-out box: every row is exactly one row height and the two
        // spacers hold the rest, so the content is `rows.length` rows tall.
        event.preventDefault();
        const toEnd = event.key === "End";
        const maxScroll = Math.max(0, rowsRef.current.length * POPUP_ROW_HEIGHT - viewportHeight);
        const next = toEnd ? maxScroll : 0;
        list.scrollTop = next;
        setScrollTop(next);
        setEdgeJump(toEnd ? "last" : "first");
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      // cmdk loops: an arrow past the last item it can see jumps to the first.
      // Across a window that is the top of the window rather than the top of
      // the list, so a row nobody asked for. Stop at the list's own ends.
      const index = selectedIndex();
      if (index === -1) return;
      const atEnd = event.key === "ArrowDown" ? index === lastSelectable(rowsRef.current) : index === firstSelectable(rowsRef.current);
      if (atEnd) event.preventDefault();
    },
    [selectedIndex, viewportHeight],
  );

  // The edge a Home or End asked for is rendered now, so cmdk can be told to
  // select it. It is told the way the pointer tells it — a `pointermove` on
  // the row runs cmdk's own handler, which sets its store's value and with it
  // `aria-activedescendant`. The `value` prop would not.
  useLayoutEffect(() => {
    if (edgeJump === null) return;
    const list = elementRef.current;
    if (list === null) return;
    const items = list.querySelectorAll(ITEM_SELECTOR);
    const target = edgeJump === "first" ? items[0] : items[items.length - 1];
    setEdgeJump(null);
    if (!(target instanceof HTMLElement)) return;
    target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  }, [edgeJump, window, viewportHeight]);

  return { listRef, listElement, window, onScroll, onKeyDown };
}
