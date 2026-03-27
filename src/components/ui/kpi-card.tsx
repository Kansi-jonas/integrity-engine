import { cn } from "@/lib/utils";
import { ArrowUp, ArrowDown } from "lucide-react";

interface KpiCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  trend?: { value: string; positive: boolean };
  icon?: React.ComponentType<{ className?: string }>;
  accentColor?: string;
  className?: string;
}

export function KpiCard({
  label,
  value,
  subtitle,
  trend,
  icon: Icon,
  accentColor = "text-brand",
  className,
}: KpiCardProps) {
  return (
    <div
      className={cn(
        "relative bg-white border border-gray-200 rounded-lg p-3 sm:p-4 md:p-5 shadow-[var(--shadow-xs)]",
        className
      )}
    >
      {Icon && (
        <div
          className={cn(
            "absolute top-3 right-3 sm:top-4 sm:right-4 flex items-center justify-center w-8 h-8 rounded-lg bg-gray-50",
            accentColor
          )}
        >
          <Icon className="w-4 h-4" />
        </div>
      )}
      <p className="text-[11px] uppercase tracking-wider font-medium text-gray-500">
        {label}
      </p>
      <div className="flex items-baseline gap-2 mt-1.5">
        <span className="text-[20px] sm:text-[24px] font-semibold text-gray-900 tabular-nums leading-tight">
          {value}
        </span>
        {trend && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[12px] font-medium rounded-md px-1.5 py-0.5",
              trend.positive
                ? "text-emerald-700 bg-emerald-50"
                : "text-red-700 bg-red-50"
            )}
          >
            {trend.positive ? (
              <ArrowUp className="w-3 h-3" />
            ) : (
              <ArrowDown className="w-3 h-3" />
            )}
            {trend.value}
          </span>
        )}
      </div>
      {subtitle && (
        <p className="text-[12px] text-gray-400 mt-1">{subtitle}</p>
      )}
    </div>
  );
}
