"use client";

import { heroAreaLabel, smallAlertTone, AlertItem } from "@/lib/alerts/helpers";
import { formatTime } from "@/lib/weather/formatters";

export default function SmallAlertCard({
  alert,
  onClick,
}: {
  alert: AlertItem;
  onClick: (alert: AlertItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(alert)}
      className={`min-w-[140px] rounded-[16px] border border-white/10 bg-gradient-to-br ${smallAlertTone(alert.event)} p-3 text-left text-white shadow-lg`}
    >
      <div className="text-[10px] font-black uppercase leading-4 tracking-wide">{alert.event}</div>
      <div className="mt-2 line-clamp-2 text-base font-black leading-tight">{heroAreaLabel(alert)}</div>
      <div className="mt-2 text-xs font-semibold text-white/90">Until {formatTime(alert.expires)}</div>
    </button>
  );
}
