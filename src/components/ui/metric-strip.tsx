import { cn } from "@/lib/utils";

interface MetricStripProps {
  metrics: Array<{
    label: string;
    value: string | number;
    color?: string;
  }>;
  className?: string;
}

export function MetricStrip({ metrics, className }: MetricStripProps) {
  return (
    <div className={cn("grid grid-cols-2 sm:flex sm:items-center gap-3 sm:gap-6", className)}>
      {metrics.map((metric) => (
        <div key={metric.label} className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-gray-400 font-medium">
            {metric.label}
          </span>
          <span
            className={cn(
              "text-[14px] font-semibold tabular-nums",
              metric.color || "text-gray-900"
            )}
          >
            {metric.value}
          </span>
        </div>
      ))}
    </div>
  );
}
