import { describe, expect, it } from "vitest";
import { previewableImageMime } from "./constants";

describe("previewableImageMime", () => {
  it("answers the MIME type for the formats the panel renders", () => {
    expect(previewableImageMime("a.png")).toBe("image/png");
    expect(previewableImageMime("dir/b.JPG")).toBe("image/jpeg");
    expect(previewableImageMime("c.webp")).toBe("image/webp");
    expect(previewableImageMime("d.gif")).toBe("image/gif");
  });

  it("answers null for anything it cannot render", () => {
    // SVG is text, so the diff itself is the more useful view.
    expect(previewableImageMime("icon.svg")).toBeNull();
    expect(previewableImageMime("archive.zip")).toBeNull();
    expect(previewableImageMime("font.woff2")).toBeNull();
    expect(previewableImageMime("no-extension")).toBeNull();
    expect(previewableImageMime(".hidden")).toBeNull();
    expect(previewableImageMime(null)).toBeNull();
    expect(previewableImageMime(undefined)).toBeNull();
  });

  it("reads the last extension of a dotted name", () => {
    expect(previewableImageMime("a.tar.png")).toBe("image/png");
    expect(previewableImageMime("a.png.txt")).toBeNull();
  });
});
