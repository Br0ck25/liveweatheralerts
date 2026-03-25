"use client";

import { ChevronRight } from "lucide-react";
import { heroAreaLabel, smallAlertTone, AlertItem } from "@/lib/alerts/helpers";
import { formatTime } from "@/lib/weather/formatters";

export default function SingleSecondaryAlertCard({
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
      className={`w-full rounded-[18px] border border-white/10 bg-gradient-to-br ${smallAlertTone(alert.event)} p-4 text-left text-white shadow-lg`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-white/90">{alert.event}</div>
          <div className="mt-2 text-xl font-black leading-tight">{heroAreaLabel(alert)}</div>
          <div className="mt-2 text-sm font-semibold text-white/90">Until {formatTime(alert.expires)}</div>
        </div>

        <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-white/90" />
      </div>
    </button>
  );
}
