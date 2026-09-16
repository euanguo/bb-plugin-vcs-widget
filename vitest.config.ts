import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // bb plugin build replaces this import with the host's runtime shim.
      // Vitest runs outside that host, so it exercises the identical vendored
      // icon implementation instead.
      "@bb/shared-ui/icon": fileURLToPath(new URL("./test/icon-shim.tsx", import.meta.url)),
      // Same story for the diff renderer: the real one needs a shadow root
      // and a worker pool. Parsing (@pierre/diffs) stays real.
      "@pierre/diffs/react": fileURLToPath(new URL("./test/pierre-react-shim.tsx", import.meta.url)),
    },
  },
  test: {
    // Pure modules, the host entry and the server run under node; app tests
    // opt into jsdom with a `// @vitest-environment jsdom` header.
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 30_000,
  },
});
