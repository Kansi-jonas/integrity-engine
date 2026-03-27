import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function SectionHeader({
  title,
  subtitle,
  badge,
  action,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <div className="flex items-center gap-2.5 min-w-0">
        <h2 className="text-[15px] font-semibold text-gray-900">{title}</h2>
        {badge}
      </div>
      <div className="flex items-center gap-2">
        {subtitle && (
          <span className="text-[13px] text-gray-500">{subtitle}</span>
        )}
        {action}
      </div>
    </div>
  );
}
