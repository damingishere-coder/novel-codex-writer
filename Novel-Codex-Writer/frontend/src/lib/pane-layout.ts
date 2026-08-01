export type PaneSide = "left" | "right";

export interface PaneWidths {
  left: number;
  right: number;
}

export const DEFAULT_PANE_WIDTHS: PaneWidths = {
  left: 310,
  right: 480
};

export const PANE_WIDTH_LIMITS: Record<PaneSide, { min: number; max: number }> = {
  left: { min: 220, max: 420 },
  right: { min: 400, max: 680 }
};

export const MIN_DOCUMENT_WIDTH = 480;
export const PANE_RESIZE_HANDLE_WIDTH = 8;
export const COMPACT_LAYOUT_MAX_WIDTH = 1299;
export const COMPACT_VISIBLE_GUTTER = 64;

export function readStoredPaneWidth(value: string | null, side: PaneSide) {
  if (value === null || value.trim() === "") return DEFAULT_PANE_WIDTHS[side];
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? clamp(parsed, PANE_WIDTH_LIMITS[side].min, PANE_WIDTH_LIMITS[side].max)
    : DEFAULT_PANE_WIDTHS[side];
}

export function clampPaneWidth(
  side: PaneSide,
  requestedWidth: number,
  options: {
    containerWidth: number;
    otherPaneWidth: number;
    resizeHandleCount: number;
    compact: boolean;
  }
) {
  const limits = PANE_WIDTH_LIMITS[side];
  if (!Number.isFinite(requestedWidth)) return DEFAULT_PANE_WIDTHS[side];
  if (!Number.isFinite(options.containerWidth) || options.containerWidth <= 0) {
    return clamp(requestedWidth, limits.min, limits.max);
  }

  const availableMaximum = options.compact
    ? options.containerWidth - COMPACT_VISIBLE_GUTTER
    : options.containerWidth
      - options.otherPaneWidth
      - MIN_DOCUMENT_WIDTH
      - options.resizeHandleCount * PANE_RESIZE_HANDLE_WIDTH;
  const maximum = Math.max(limits.min, Math.min(limits.max, availableMaximum));
  return clamp(requestedWidth, limits.min, maximum);
}

export function fitPaneWidths(
  requested: PaneWidths,
  options: {
    containerWidth: number;
    leftCollapsed: boolean;
    rightVisible: boolean;
  }
): PaneWidths {
  let left = clamp(requested.left, PANE_WIDTH_LIMITS.left.min, PANE_WIDTH_LIMITS.left.max);
  let right = clamp(requested.right, PANE_WIDTH_LIMITS.right.min, PANE_WIDTH_LIMITS.right.max);

  if (
    !Number.isFinite(options.containerWidth)
    || options.containerWidth <= COMPACT_LAYOUT_MAX_WIDTH
  ) {
    return { left, right };
  }

  const resizeHandleCount = Number(!options.leftCollapsed) + Number(options.rightVisible);
  const availableForPanes = Math.max(
    0,
    options.containerWidth
      - MIN_DOCUMENT_WIDTH
      - resizeHandleCount * PANE_RESIZE_HANDLE_WIDTH
      - (options.leftCollapsed ? 58 : 0)
  );

  if (options.leftCollapsed) {
    right = Math.min(right, Math.max(PANE_WIDTH_LIMITS.right.min, availableForPanes));
    return { left, right };
  }
  if (!options.rightVisible) {
    left = Math.min(left, Math.max(PANE_WIDTH_LIMITS.left.min, availableForPanes));
    return { left, right };
  }

  let overflow = Math.max(0, left + right - availableForPanes);
  const leftReduction = Math.min(overflow, left - PANE_WIDTH_LIMITS.left.min);
  left -= leftReduction;
  overflow -= leftReduction;
  right -= Math.min(overflow, right - PANE_WIDTH_LIMITS.right.min);

  return { left, right };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
