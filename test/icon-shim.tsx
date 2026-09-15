// Vitest runs outside the bb host that normally provides @bb/shared-ui/icon
// as a runtime shim. This is deliberately tiny: tests need an SVG carrying
// the requested name, not a second copy of the hugeicons map.
import type { CSSProperties, ReactElement } from "react";

export type IconName = string;
export const ICON_NAMES: readonly IconName[] = [];
export const preloadExtendedIcons = async (): Promise<void> => undefined;
export const isBuiltinIconName = (_name: string): boolean => true;

export function Icon({
  name,
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: {
  name: IconName;
  fallback?: IconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}): ReactElement {
  return (
    <svg
      data-icon={name}
      className={className}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    />
  );
}
