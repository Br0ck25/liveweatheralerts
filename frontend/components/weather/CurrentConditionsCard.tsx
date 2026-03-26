"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Compass } from "lucide-react";
import { iconForHourly } from "@/lib/weather/formatters";

type CurrentConditions = {
  temp: number;
  feelsLike: number;
  condition: string;
  wind: string;
  humidity: number;
  uv: string;
  icon: "storm" | "sun" | "cloud" | "night";
  sunrise?: string | null;
  sunset?: string | null;
  isNight?: boolean;
};

export default function CurrentConditionsCard({
  current,
  locationLabel,
}: {
  current: CurrentConditions;
  locationLabel: string;
}) {
  return (
    <Card className="rounded-[30px] border border-blue-900/40 bg-gradient-to-br from-blue-950 via-blue-900 to-slate-950 text-white shadow-xl">
      <CardContent className="pt-6 pb-5 px-5">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-xl font-black uppercase tracking-wide text-white/95">
            Current Conditions
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-blue-100">
            <Compass className="h-4 w-4" />
            {locationLabel}
          </div>
        </div>

        <div className="grid grid-cols-[120px_1fr] gap-4">
          <div className="rounded-[24px] bg-white/5 p-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center">
              {iconForHourly(current.icon)}
            </div>
            <div className="mt-4 text-6xl font-black leading-none">{current.temp}°</div>
            <div className="mt-2 text-sm font-medium text-blue-100">
              Feels like {current.feelsLike}°
            </div>
          </div>

          <div className="space-y-4 rounded-[24px] bg-white/5 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <span className="flex h-5 w-5 items-center justify-center">
                {iconForHourly(current.icon)}
              </span>
              {current.condition}
            </div>

            <div className="grid grid-cols-1 gap-3 text-sm font-medium text-blue-100">
              <div className="flex items-center justify-between">
                <span>Wind</span>
                <span>{current.wind}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Humidity</span>
                <span>{current.humidity}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span>UV Index</span>
                <span>{current.uv}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
