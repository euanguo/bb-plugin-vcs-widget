// `bb plugin build` replaces @bb/shared-ui/icon with the host's runtime shim
// (see packages/plugin-build/src/runtime-shims.mjs in bb). @bb/shared-ui is
// intentionally private and therefore has no npm declaration package for an
// external plugin to install. Keep this declaration deliberately narrow: it
// describes the host contract this plugin actually uses, without bundling a
// second hugeicons map.
declare module "@bb/shared-ui/icon" {
  import type { CSSProperties, ReactElement } from "react";

  export type IconName = string;
  export const ICON_NAMES: readonly IconName[];
  export function preloadExtendedIcons(): Promise<void>;
  export function isBuiltinIconName(name: string): boolean;
  export function Icon(props: {
    name: IconName;
    fallback?: IconName;
    className?: string;
    style?: CSSProperties;
    "aria-hidden"?: boolean | "true" | "false";
    "aria-label"?: string;
  }): ReactElement | null;
}
