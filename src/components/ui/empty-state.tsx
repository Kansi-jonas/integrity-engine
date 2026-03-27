import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  loading?: boolean;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  loading = false,
  action,
  className,
}: EmptyStateProps) {
  if (loading) {
    return (
      <div className={cn("flex flex-col items-center justify-center py-16", className)}>
        <div className="w-8 h-8 border-2 border-gray-200 border-t-[var(--color-brand)] rounded-full animate-spin" />
        <p className="text-[13px] text-gray-500 mt-3">{title}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center justify-center py-16", className)}>
      {Icon && <Icon className="w-12 h-12 text-gray-300 mb-3" />}
      <p className="text-[15px] font-medium text-gray-900">{title}</p>
      {description && (
        <p className="text-[13px] text-gray-500 mt-1 max-w-sm text-center">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
