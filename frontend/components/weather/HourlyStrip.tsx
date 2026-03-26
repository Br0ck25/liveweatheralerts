"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { iconForHourly } from "@/lib/weather/formatters";

export type HourlyPoint = {
  label: string;
  temp: number;
  icon: "storm" | "sun" | "cloud" | "night";
  precip?: number;
  startTime?: string;
  shortForecast?: string;
};

export default function HourlyStrip({
  points,
  onView10Day,
}: {
  points: HourlyPoint[];
  onView10Day: () => void;
}) {
  return (
    <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <CardContent className="pt-6 pb-5 px-5">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-xl font-black uppercase tracking-wide">Next 18 Hours</div>
          <Button
            variant="secondary"
            className="h-9 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
            onClick={onView10Day}
          >
            View 10-Day
          </Button>
        </div>

        <div className="relative">
          <div className="no-scrollbar flex gap-3 overflow-x-auto px-2 pb-1 snap-x snap-mandatory">
            {points.map((point, index) => (
              <div
                key={`${point.label}-${point.startTime ?? index}`}
                className={`relative min-w-[110px] snap-start rounded-[24px] border ${index === 0 ? 'border-white/20 bg-gradient-to-b from-blue-800/85' : 'border-white/10 bg-gradient-to-b from-blue-900/70'} to-slate-900 px-4 py-3 text-center shadow-md shadow-black/30`}
              >
                <div className="text-[11px] font-bold uppercase text-sky-300">{point.label}</div>
                <div className="mt-2 flex justify-center">{iconForHourly(point.icon)}</div>

                <div className="mt-2 text-[22px] font-black leading-none">{point.temp}°</div>

                <div className="mt-1 text-[11px] text-slate-400">{point.precip ?? 0}%</div>
              </div>
            ))}
          </div>

          <div className="pointer-events-none absolute left-0 top-0 h-full w-4 bg-gradient-to-r from-slate-950 to-transparent" />
          <div className="pointer-events-none absolute right-0 top-0 h-full w-4 bg-gradient-to-l from-slate-950 to-transparent" />
        </div>
      </CardContent>
    </Card>
  );
}
