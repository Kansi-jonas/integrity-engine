/**
 * Shared Recharts theme configuration.
 * Stripe Dashboard aesthetic: clean lines, subtle colors, warm grays.
 */

export const CHART_COLORS = [
  "#0067ff", // brand blue
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
] as const;

export const chartGrid = {
  strokeDasharray: "3 3",
  stroke: "#e4e4e7",
  vertical: false,
} as const;

export const chartXAxis = {
  stroke: "transparent",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
  tick: { fill: "#71717a" },
} as const;

export const chartYAxis = {
  stroke: "transparent",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
  tick: { fill: "#71717a" },
} as const;

export const chartTooltipStyle = {
  borderRadius: 8,
  border: "1px solid #e4e4e7",
  boxShadow: "0 4px 6px -1px rgba(0,0,0,0.06)",
  fontSize: 13,
  backgroundColor: "#ffffff",
} as const;

export const chartMargin = {
  top: 5,
  right: 20,
  bottom: 5,
  left: 0,
} as const;

/** Helper to get a chart color by index (wraps around) */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Area chart gradient helper */
export function areaGradientId(color: string): string {
  return `gradient-${color.replace("#", "")}`;
}
