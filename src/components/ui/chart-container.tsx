"use client";

import { cn } from "@/lib/utils";
import { ResponsiveContainer } from "recharts";

interface ChartContainerProps {
  title: string;
  subtitle?: string;
  legend?: React.ReactNode;
  height?: number;
  children: React.ReactNode;
  className?: string;
}

export function ChartContainer({
  title,
  subtitle,
  legend,
  height = 320,
  children,
  className,
}: ChartContainerProps) {
  return (
    <div
      className={cn(
        "bg-white border border-gray-200 rounded-lg shadow-[var(--shadow-xs)]",
        className
      )}
    >
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4 p-3 sm:p-5 pb-0 sm:pb-0">
        <div>
          <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
          {subtitle && (
            <p className="text-[13px] text-gray-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        {legend && <div className="flex items-center gap-3 shrink-0">{legend}</div>}
      </div>
      <div className="px-3 sm:px-5 pb-3 sm:pb-5 pt-3 sm:pt-4">
        <div className="h-[200px] sm:h-[260px] md:h-[320px]" style={height !== 320 ? { height } : undefined}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
