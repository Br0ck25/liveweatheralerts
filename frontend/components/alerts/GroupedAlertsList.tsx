"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { AlertItem, dedupeArea } from "@/lib/alerts/helpers";
import { formatTime } from "@/lib/weather/formatters";
import { cn } from "@/lib/utils";

export function groupByEvent(alerts: AlertItem[]) {
  return alerts.reduce<Record<string, AlertItem[]>>((memo, alert) => {
    const key = alert.event?.trim() || "Other Alerts";
    if (!memo[key]) memo[key] = [];
    memo[key].push(alert);
    return memo;
  }, {});
}

export default function GroupedAlertsList({
  alerts,
  onSelectAlert,
}: {
  alerts: AlertItem[];
  onSelectAlert: (alert: AlertItem) => void;
}) {
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  const groups = groupByEvent(alerts);
  const eventKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  if (eventKeys.length === 0) return null;

  return (
    <div className="rounded-[28px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <div className="px-4 py-4 text-xl font-black uppercase tracking-wide">Other Active Alerts ({alerts.length})</div>
      {eventKeys.map((event) => {
        const items = groups[event];
        const isOpen = expandedEvent === event;

        return (
          <div key={event} className="border-t border-white/10">
            <button
              type="button"
              onClick={() => setExpandedEvent(isOpen ? null : event)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left font-bold text-white hover:bg-white/5"
            >
              <div>
                <div className="text-sm uppercase tracking-wide">{event}</div>
                <div className="text-xs text-slate-300">{items.length} alert{items.length > 1 ? "s" : ""}</div>
              </div>
              <div className="inline-flex items-center gap-1 text-slate-300">
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </div>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-white/10 px-4 py-3">
                {items.map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => onSelectAlert(alert)}
                    className={cn(
                      "w-full rounded-xl border border-white/10 px-3 py-2 text-left hover:bg-white/5",
                      "transition"
                    )}
                  >
                    <div className="text-sm font-bold text-white">
                      {dedupeArea(alert.areaDesc)}
                    </div>
                    <div className="mt-1 text-xs text-slate-300">
                      Until {formatTime(alert.expires)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
