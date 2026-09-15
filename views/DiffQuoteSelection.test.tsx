// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const addQuote = vi.fn();

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useComposer: () => ({ addQuote }),
}));

import { DiffQuoteSelection } from "./DiffQuoteSelection";

afterEach(() => {
  addQuote.mockReset();
  window.getSelection()?.removeAllRanges();
});

function selectText(node: Text) {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.data.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("DiffQuoteSelection", () => {
  it("adds the selected diff text to the composer draft and never submits it", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DiffQuoteSelection path="src/example.ts">
        <pre>+const answer = 42;</pre>
      </DiffQuoteSelection>,
    );
    const pre = screen.getByText("+const answer = 42;");
    const text = pre.firstChild;
    if (!(text instanceof Text)) throw new Error("expected a text node");

    // Selection is accepted only when the pointer began inside the card.
    fireEvent.pointerDown(container.firstElementChild!, { pointerId: 1 });
    selectText(text);
    fireEvent.pointerUp(container.firstElementChild!, { pointerId: 1 });

    const button = await screen.findByTestId("vcs-diff-add-to-chat");
    expect(button.textContent).toContain("Add to chat");
    await user.click(button);

    // `addQuote`, unlike an RPC send, only changes the editor's draft.
    expect(addQuote).toHaveBeenCalledTimes(1);
    expect(addQuote).toHaveBeenCalledWith("src/example.ts\n+const answer = 42;");
    expect(screen.queryByTestId("vcs-diff-add-to-chat")).toBeNull();
  });

  it("does nothing for an empty selection", async () => {
    const { container } = render(
      <DiffQuoteSelection path="src/example.ts">
        <pre>+const answer = 42;</pre>
      </DiffQuoteSelection>,
    );
    fireEvent.pointerDown(container.firstElementChild!, { pointerId: 1 });
    fireEvent.pointerUp(container.firstElementChild!, { pointerId: 1 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByTestId("vcs-diff-add-to-chat")).toBeNull();
    expect(addQuote).not.toHaveBeenCalled();
  });
});
