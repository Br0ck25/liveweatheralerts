"use client";

import { TriangleAlert, CloudRain, CloudFog, Waves } from "lucide-react";
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

  if (text.includes("fog")) return { label: "Fog", icon: CloudFog };
  if (text.includes("flood") || text.includes("high surf") || text.includes("coastal")) return { label: "Flood", icon: Waves };
  if (text.includes("storm") || text.includes("thunderstorm") || text.includes("tornado") || text.includes("rain")) return { label: "Storm", icon: CloudRain };

  return { label: "Alert", icon: TriangleAlert };
}

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
      <div className="flex items-center gap-1 text-[10px] font-black uppercase leading-4 tracking-wide text-white/90">
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
      <div className="mt-2 line-clamp-2 text-base font-black leading-tight">{heroAreaLabel(alert)}</div>
      <div className="mt-2 text-xs text-white/90">
        <div>Issued {formatIssuedTime(alert.sent || alert.effective)}</div>
        <div>Until {formatTime(alert.expires)}</div>
      </div>
    </button>
  );
}
