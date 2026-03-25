"use client";

import { ChevronRight, TriangleAlert, CloudRain, CloudFog, Waves } from "lucide-react";
import { heroAreaLabel, smallAlertTone, AlertItem } from "@/lib/alerts/helpers";
import { formatTime } from "@/lib/weather/formatters";

function formatIssuedTime(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAlertTypeMeta(event?: string) {
  const text = String(event || "").toLowerCase();

  if (text.includes("fog")) {
    return { label: "Fog", icon: CloudFog };
  }

  if (text.includes("flood") || text.includes("high surf") || text.includes("coastal")) {
    return { label: "Flood", icon: Waves };
  }

  if (text.includes("storm") || text.includes("thunderstorm") || text.includes("tornado") || text.includes("rain")) {
    return { label: "Storm", icon: CloudRain };
  }

  return { label: "Alert", icon: TriangleAlert };
}

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
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-black uppercase tracking-wide text-white/90">
            {(() => {
              const typeMeta = getAlertTypeMeta(alert.event);
              const Icon = typeMeta.icon;
              return (
                <>
                  <Icon className="h-3.5 w-3.5" />
                  {typeMeta.label}
                </>
              );
            })()}
          </div>
          <div className="mt-2 text-xl font-black leading-tight">{heroAreaLabel(alert)}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-white/90">
            <div>
              <span className="font-black text-white">Issued:</span> {formatIssuedTime(alert.sent || alert.effective)}
            </div>
            <div>
              <span className="font-black text-white">Until:</span> {formatTime(alert.expires)}
            </div>
          </div>
        </div>

        <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-white/90" />
      </div>
    </button>
  );
}
