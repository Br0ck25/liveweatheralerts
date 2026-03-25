"use client";

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
              {radar?.summary || "Live radar available"}
            </div>
            <div className="mt-3 text-xs font-medium leading-5 text-slate-300">
              Updated {formatRelative(radar?.updated)}
            </div>
          </div>

          <button
            type="button"
            onClick={onViewRadar}
            className="relative overflow-hidden rounded-[22px] border border-white/10 bg-slate-900 text-left transition hover:border-sky-400/40 hover:bg-slate-800/80 active:scale-[0.99]"
            aria-label="Open live radar"
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_25%,rgba(255,196,0,0.30),transparent_18%),linear-gradient(135deg,rgba(34,197,94,0.28),transparent_25%),linear-gradient(160deg,rgba(250,204,21,0.24),transparent_45%),linear-gradient(200deg,rgba(239,68,68,0.30),transparent_62%),linear-gradient(180deg,#162033_0%,#0b1220_100%)]" />
            <div className="relative flex h-full min-h-[130px] flex-col justify-between p-4">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.18em] text-sky-200/80">
                  Interactive Radar
                </div>
                <div className="mt-2 text-lg font-black leading-tight text-white">
                  {radar?.summary || "Live radar available"}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <div className="text-xs font-medium text-slate-300">
                  Tap to open full-screen radar
                </div>
                <div className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white">
                  LIVE
                </div>
              </div>
            </div>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
