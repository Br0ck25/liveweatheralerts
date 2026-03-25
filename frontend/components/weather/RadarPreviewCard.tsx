"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Radar } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/weather/formatters";

type AlertState = "ACTIVE_ALERTS" | "NO_ALERTS";

type RadarData = {
  station: string | null;
  loopImageUrl: string | null;
  stillImageUrl: string | null;
  updated: string;
  summary: string;
};

export default function RadarPreviewCard({
  alertState,
  radar,
  onViewRadar,
}: {
  alertState: AlertState;
  radar: RadarData | null;
  onViewRadar: () => void;
}) {
  const [hasOpenedRadar, setHasOpenedRadar] = useState(false);
  const hasStillImage = Boolean(radar?.stillImageUrl);

  return (
    <Card className="overflow-hidden rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase tracking-wide">
          <Radar className="h-5 w-5 text-red-400" />
          Live Radar
        </div>

        <div className="grid grid-cols-[120px_1fr] gap-3">
          <div className="rounded-[22px] bg-white/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <span
                className={cn(
                  "h-3 w-3 rounded-full",
                  alertState === "ACTIVE_ALERTS" ? "bg-green-400" : "bg-blue-400"
                )}
              />
              {radar?.summary || "Interactive radar ready"}
            </div>

            <div className="mt-3 text-xs font-medium leading-5 text-slate-300">
              Updated {formatRelative(radar?.updated)}
            </div>

            {radar?.station ? (
              <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                Station {radar.station}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => {
              setHasOpenedRadar(true);
              onViewRadar();
            }}
            className="relative overflow-hidden rounded-[22px] border border-white/10 bg-slate-900 text-left transition hover:border-sky-400/50 hover:bg-slate-800/80 hover:shadow-[0_10px_30px_rgba(56,189,248,0.15)] active:scale-[0.98]"
            aria-label="Open live radar"
          >
            {hasStillImage ? (
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${radar?.stillImageUrl})` }}
              />
            ) : null}

            <div
              className={cn(
                "absolute inset-0",
                hasStillImage
                  ? "bg-gradient-to-br from-slate-950/45 via-slate-950/35 to-slate-950/80"
                  : "bg-[radial-gradient(circle_at_60%_25%,rgba(255,196,0,0.30),transparent_18%),linear-gradient(135deg,rgba(34,197,94,0.28),transparent_25%),linear-gradient(160deg,rgba(250,204,21,0.24),transparent_45%),linear-gradient(200deg,rgba(239,68,68,0.30),transparent_62%),linear-gradient(180deg,#162033_0%,#0b1220_100%)]"
              )}
            />

            <div className="relative flex h-full min-h-[130px] flex-col justify-between p-4">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.18em] text-sky-200/80">
                  Interactive Radar
                </div>

                <div className="mt-2 text-lg font-black leading-tight text-white">
                  {radar?.summary || "Live Radar"}
                </div>
              </div>

              <div className="flex items-end justify-between gap-3">
                {!hasOpenedRadar ? (
                  <div className="text-sm font-medium text-slate-100">
                    Tap to open full-screen radar
                  </div>
                ) : null}

                <div className="flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-black uppercase tracking-wide text-white backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse"></span>
                  Live
                </div>
              </div>
            </div>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
