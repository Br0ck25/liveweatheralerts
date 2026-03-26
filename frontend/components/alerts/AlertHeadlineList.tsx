"use client";

import { Card, CardContent } from "@/components/ui/card";
import { ShieldAlert, ChevronRight, TriangleAlert, CloudRain, CloudFog, Waves } from "lucide-react";
import { dedupeArea, getAlertBackground, getHeroVariantBackgroundImageIfExists, AlertItem } from "@/lib/alerts/helpers";
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

export default function AlertHeadlineList({
  alerts,
  onSelectAlert,
}: {
  alerts: AlertItem[];
  onSelectAlert: (alert: AlertItem) => void;
}) {
  return (
    <Card className="rounded-[28px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <CardContent className="p-4">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase tracking-wide">
          <ShieldAlert className="h-5 w-5 text-red-400" />
          Alert Headlines
        </div>

        <div className="space-y-3">
          {alerts.slice(0, 4).map((alert) => {
            const typeMeta = getAlertTypeMeta(alert.event);
            const Icon = typeMeta.icon;

            const cardBgImage = getHeroVariantBackgroundImageIfExists(alert.event);
            const tone = getAlertBackground(alert.event);

            return (
              <button
                key={alert.id}
                type="button"
                onClick={() => onSelectAlert(alert)}
                className="relative flex w-full items-center justify-between rounded-[20px] border border-red-500/20 px-4 py-3 text-left text-white shadow-lg overflow-hidden"
                style={{
                  backgroundImage: cardBgImage ? `url(${cardBgImage})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                <div className="absolute inset-0" style={{ background: tone, opacity: 0.7 }} />
                <div className="relative z-10 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-black uppercase tracking-wide text-white">
                    <Icon className="h-4 w-4" />
                    {typeMeta.label}
                  </div>
                  <div className="truncate text-sm text-white/90">{alert.headline || dedupeArea(alert.areaDesc)}</div>
                  <div className="mt-1 text-xs text-white/80">
                    Issued {formatIssuedTime(alert.sent || alert.effective)} • Until {formatTime(alert.expires)}
                  </div>
                </div>
                <ChevronRight className="relative z-10 ml-3 h-5 w-5 shrink-0 text-white" />
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
