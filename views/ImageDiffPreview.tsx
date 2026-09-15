// Both sides of a changed image, side by side, so a picture can be reviewed
// in the panel rather than being summarised as "Binary file.".
//
// The sides are labelled by what they are (before/after, or which side has
// nothing) because a rename or a new file means the two pictures may not be
// the same file at all.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { errorMessage } from "../lib/errors";

/** A file size the way a person reads it: `12.3 KB`, `1.4 MB`. */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

interface ImageSide {
  base64: string;
  sizeBytes: number;
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; old: ImageSide | null; new: ImageSide | null }
  | { status: "error"; message: string };

interface ImageDiffPreviewProps {
  threadId: string;
  path: string;
  oldPath: string | null;
  side: "index" | "worktree";
  mimeType: string;
}

export function ImageDiffPreview({ threadId, path, oldPath, side, mimeType }: ImageDiffPreviewProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    rpc.call("imagePreview", { threadId, path, oldPath, side, mimeType }).then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", old: result.old, new: result.new }
            : { status: "error", message: result.error.message },
        );
      },
      (cause) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(cause) ?? "Failed to read the image." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, path, oldPath, side, mimeType]);

  if (state.status === "loading") {
    return <p className="px-3 py-3 text-xs text-muted-foreground">Reading image…</p>;
  }
  if (state.status === "error") {
    return <p className="px-3 py-3 text-xs text-destructive">{state.message}</p>;
  }
  const { old: oldSide, new: newSide } = state;
  if (oldSide === null && newSide === null) {
    // Both sides unreadable: too large, or gone from both revisions.
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        No preview available for this image. It may be larger than the panel will show.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-2" data-testid="vcs-image-preview">
      <ImageSideView label={oldSide === null ? "Before (absent)" : "Before"} mimeType={mimeType} side={oldSide} />
      <ImageSideView label={newSide === null ? "After (absent)" : "After"} mimeType={mimeType} side={newSide} />
    </div>
  );
}

function ImageSideView({
  label,
  mimeType,
  side,
}: {
  label: string;
  mimeType: string;
  side: ImageSide | null;
}) {
  if (side === null) {
    return (
      <figure className="min-w-0">
        <figcaption className="mb-1 text-xs text-muted-foreground">{label}</figcaption>
        <div className="flex h-32 items-center justify-center rounded-md border border-border bg-surface-recessed text-xs text-muted-foreground">
          Nothing here
        </div>
      </figure>
    );
  }
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1 text-xs text-muted-foreground">
        {label} · {formatByteSize(side.sizeBytes)}
      </figcaption>
      <a
        href={`data:${mimeType};base64,${side.base64}`}
        target="_blank"
        rel="noreferrer"
        className="flex h-32 items-center justify-center rounded-md border border-border bg-surface-recessed p-2"
        title="Open the image at full size"
      >
        <img
          src={`data:${mimeType};base64,${side.base64}`}
          alt={label}
          className="block max-h-full max-w-full object-contain"
        />
      </a>
    </figure>
  );
}
