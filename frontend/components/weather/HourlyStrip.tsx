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

        <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          {points.map((point, index) => (
            <div
              key={`${point.label}-${point.startTime ?? index}`}
              className="min-w-[92px] rounded-[24px] border border-white/10 bg-gradient-to-b from-blue-900/70 to-slate-900 p-4 text-center shadow-md shadow-black/30"
            >
              <div className="text-xs font-bold uppercase text-sky-300">{point.label}</div>
              <div className="mt-1">{iconForHourly(point.icon)}</div>
              <div className="mt-1 text-xl font-black">{point.temp}°</div>
              <div className="mt-1 text-xs text-slate-300">{point.precip ?? 0}%</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
