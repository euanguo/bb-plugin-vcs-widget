// A selection in a diff becomes a quote in the thread's composer. This is the
// same boundary bb's own "Add to chat" action uses: prepare a draft, never
// send a message. The plugin deliberately keeps its normal host diff renderer
// instead of replacing it globally just to add one interaction.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@bb/shared-ui/icon";

interface DiffQuoteSelectionProps {
  path: string;
  children: ReactNode;
}

interface SelectionState {
  text: string;
  x: number;
  y: number;
}

/**
 * The host's diff renderer can use a shadow root. Pointer events still bubble
 * through the panel, so the pointer-start flag is more reliable than asking a
 * light-DOM wrapper whether it contains the range's common ancestor.
 */
export function DiffQuoteSelection({ path, children }: DiffQuoteSelectionProps) {
  const composer = useComposer();
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerStartedInside = useRef(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);

  const clear = useCallback(() => setSelection(null), []);

  const captureSelection = useCallback(() => {
    if (!pointerStartedInside.current) return;
    const nativeSelection = window.getSelection();
    if (nativeSelection === null || nativeSelection.rangeCount === 0 || nativeSelection.isCollapsed) {
      clear();
      return;
    }
    const text = nativeSelection.toString().trim();
    if (text.length === 0) {
      clear();
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    // jsdom and a few embedded webviews do not implement Range geometry. The
    // card's corner is a useful fallback and, unlike a hard failure, still
    // leaves the quote action reachable.
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    const fallback = containerRef.current?.getBoundingClientRect();
    setSelection({
      text,
      x: rect?.left || fallback?.left || 0,
      y: rect?.bottom || fallback?.top || 0,
    });
  }, [clear]);

  useEffect(() => {
    const onSelectionChange = () => {
      // Let the browser finish writing the selection before reading it.
      requestAnimationFrame(captureSelection);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [captureSelection]);

  const quote = useCallback(() => {
    if (selection === null) return;
    // addQuote supplies the `> ` markers and focuses the composer. A path
    // header makes the quote useful even when multiple diff cards are quoted.
    composer.addQuote(`${path}\n${selection.text}`);
    window.getSelection()?.removeAllRanges();
    clear();
  }, [clear, composer, path, selection]);

  const keepSelection = (event: MouseEvent<HTMLButtonElement>) => {
    // A button's mousedown normally clears the native selection before click.
    event.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onPointerDownCapture={(event) => {
        pointerStartedInside.current = event.currentTarget.contains(event.target as Node);
      }}
      onPointerUpCapture={() => requestAnimationFrame(captureSelection)}
      onPointerCancel={clear}
    >
      {children}
      {selection === null ? null : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="fixed z-[80] h-7 px-2 text-xs shadow-md"
          style={{ left: selection.x, top: selection.y + 6 }}
          onMouseDown={keepSelection}
          onClick={quote}
          data-testid="vcs-diff-add-to-chat"
        >
          <Icon name="MessageSquarePlus" className="size-3.5" />
          Add to chat
        </Button>
      )}
    </div>
  );
}
