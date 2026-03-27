import { useEffect, useMemo, useState } from "react";
import { parseTime } from "../utils";

const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;
type CountdownStatus = "active" | "expiring_soon" | "expired" | "unknown";

type AlertCountdownProps = {
  expiresAt: string;
  onStatusChange?: (status: CountdownStatus) => void;
};

function toCountdownLabel(diffMs: number): string {
  if (diffMs <= 0) return "Expired";
  const totalMinutes = Math.max(0, Math.round(diffMs / 60_000));
  if (totalMinutes < 1) return "Less than 1m left";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m left`;
  if (minutes <= 0) return `${hours}h left`;
  return `${hours}h ${minutes}m left`;
}

export function AlertCountdown({ expiresAt, onStatusChange }: AlertCountdownProps) {
  const [tick, setTick] = useState(() => Date.now());
  const expiresAtMs = parseTime(expiresAt);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTick(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const { status, label } = useMemo(() => {
    if (expiresAtMs === null) {
      return {
        status: "unknown" as CountdownStatus,
        label: "Unknown"
      };
    }

    const diffMs = expiresAtMs - tick;
    if (diffMs <= 0) {
      return {
        status: "expired" as CountdownStatus,
        label: "Expired"
      };
    }
    if (diffMs <= EXPIRING_SOON_MS) {
      return {
        status: "expiring_soon" as CountdownStatus,
        label: toCountdownLabel(diffMs)
      };
    }
    return {
      status: "active" as CountdownStatus,
      label: toCountdownLabel(diffMs)
    };
  }, [expiresAtMs, tick]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  return (
    <article
      className={`alert-countdown-cell alert-countdown-${status}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <h3>Countdown</h3>
      <p>{label}</p>
      {status === "expiring_soon" ? (
        <span className="alert-countdown-note">Expiring soon</span>
      ) : null}
    </article>
  );
}
