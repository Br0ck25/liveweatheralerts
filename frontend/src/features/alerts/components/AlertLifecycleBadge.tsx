import type { AlertLifecycleStatus } from "../../../types";

const lifecycleLabel: Record<AlertLifecycleStatus, string> = {
  new: "New",
  updated: "Updated",
  extended: "Extended",
  expiring_soon: "Expiring Soon",
  expired: "Expired",
  all_clear: "All Clear"
};

type AlertLifecycleBadgeProps = {
  status: AlertLifecycleStatus;
  className?: string;
};

export function AlertLifecycleBadge({ status, className = "" }: AlertLifecycleBadgeProps) {
  return (
    <span
      className={`alert-lifecycle-badge alert-lifecycle-${status} ${className}`.trim()}
      aria-label={`Lifecycle status: ${lifecycleLabel[status]}`}
    >
      {lifecycleLabel[status]}
    </span>
  );
}

