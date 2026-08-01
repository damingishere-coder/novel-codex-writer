import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANE_WIDTHS,
  clampPaneWidth,
  fitPaneWidths,
  readStoredPaneWidth
} from "./pane-layout";

describe("工作台分栏尺寸", () => {
  it("读取有效宽度并让空值或非法值回退默认值", () => {
    expect(readStoredPaneWidth("360", "left")).toBe(360);
    expect(readStoredPaneWidth(null, "left")).toBe(DEFAULT_PANE_WIDTHS.left);
    expect(readStoredPaneWidth("not-a-number", "right")).toBe(DEFAULT_PANE_WIDTHS.right);
  });

  it("读取存储值时限制在各自允许范围内", () => {
    expect(readStoredPaneWidth("100", "left")).toBe(220);
    expect(readStoredPaneWidth("900", "right")).toBe(680);
  });

  it("宽屏拖拽会为正文保留至少 480px", () => {
    expect(clampPaneWidth("right", 680, {
      containerWidth: 1366,
      otherPaneWidth: 310,
      resizeHandleCount: 2,
      compact: false
    })).toBe(560);
  });

  it("覆盖式侧栏与另一侧栏互不挤压，并给页面留下关闭区域", () => {
    expect(clampPaneWidth("right", 680, {
      containerWidth: 700,
      otherPaneWidth: 310,
      resizeHandleCount: 2,
      compact: true
    })).toBe(636);
  });

  it("窗口空间不足时优先收窄资料库，再收窄审阅栏", () => {
    expect(fitPaneWidths(
      { left: 420, right: 680 },
      { containerWidth: 1300, leftCollapsed: false, rightVisible: true }
    )).toEqual({ left: 220, right: 584 });
  });

  it("折叠和隐藏侧栏时不改写该侧保存的宽度", () => {
    expect(fitPaneWidths(
      { left: 420, right: 680 },
      { containerWidth: 1300, leftCollapsed: true, rightVisible: true }
    )).toEqual({ left: 420, right: 680 });
    expect(fitPaneWidths(
      { left: 420, right: 680 },
      { containerWidth: 1300, leftCollapsed: false, rightVisible: false }
    )).toEqual({ left: 420, right: 680 });
  });
});
