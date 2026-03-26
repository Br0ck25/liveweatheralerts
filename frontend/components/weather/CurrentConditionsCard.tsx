"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";
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
  heroMode = false,
}: {
  current: CurrentConditions;
  locationLabel: string;
  heroMode?: boolean;
}) {
  function getGlow(icon: string) {
    if (icon === "sun") return "shadow-[0_0_80px_rgba(255,200,0,0.35)]";
    if (icon === "storm") return "shadow-[0_0_80px_rgba(56,189,248,0.35)]";
    if (icon === "cloud") return "shadow-[0_20px_60px_rgba(148,163,184,0.35)]";
    if (icon === "night") return "shadow-[0_0_70px_rgba(96,165,250,0.3)]";
    return "";
  }

  function getCardAtmosphere(icon: string) {
    if (icon === "sun") {
      return {
        card: "from-blue-950 via-blue-900/95 to-slate-950",
        glow: "bg-[radial-gradient(circle_at_18%_18%,rgba(255,220,120,0.18),transparent_38%)]",
      };
    }

    if (icon === "storm") {
      return {
        card: "from-slate-950 via-blue-950 to-slate-950",
        glow: "bg-[radial-gradient(circle_at_18%_18%,rgba(56,189,248,0.18),transparent_38%)]",
      };
    }

    if (icon === "cloud") {
      return {
        card: "from-slate-950 via-slate-900 to-blue-950",
        glow: "bg-[radial-gradient(circle_at_18%_18%,rgba(148,163,184,0.14),transparent_38%)]",
      };
    }

    return {
      card: "from-slate-950 via-blue-950 to-slate-950",
      glow: "bg-[radial-gradient(circle_at_18%_18%,rgba(96,165,250,0.16),transparent_38%)]",
    };
  }

  const atmosphere = getCardAtmosphere(current.icon);

  return (
    <Card
      className={cn(
        "relative overflow-hidden rounded-[30px] border text-white shadow-xl bg-gradient-to-br",
        atmosphere.card,
        heroMode ? "-mt-2 border-white/10" : "border-blue-900/40"
      )}
    >
      <div className={cn("absolute inset-0 opacity-90", atmosphere.glow)} />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.04)_0%,rgba(255,255,255,0)_38%,rgba(2,6,23,0.18)_100%)]" />
      <CardContent className="relative pt-5 pb-4 px-4">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-xl font-black uppercase tracking-wide text-white/95">
            Current Conditions
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-blue-100">
            <Compass className="h-4 w-4" />
            {locationLabel}
          </div>
        </div>

        <div className="grid grid-cols-[140px_1fr] gap-5">
          <div className="relative rounded-[26px] bg-gradient-to-b from-white/10 to-white/5 backdrop-blur p-4 text-center border border-white/15 shadow-inner">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,0.08),transparent_60%)] pointer-events-none rounded-[26px]" />
            <div
              className={cn(
                "relative mx-auto flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br from-white/10 to-white/0 ring-1 ring-white/10 animate-[pulse_8s_ease-in-out_infinite]",
                getGlow(current.icon)
              )}
            >
              <div className="absolute inset-2 rounded-full bg-white/5 blur-md opacity-60" />
              <div className="relative z-10">{iconForHourly(current.icon, "current")}</div>
            </div>
            <div className="mt-4 text-[4.5rem] font-extrabold leading-none tracking-tight">{current.temp}°</div>
            <div className="mt-2 text-sm font-medium text-blue-100">
              Feels like {current.feelsLike}°
            </div>
          </div>

          <div className="space-y-4 rounded-[24px] bg-gradient-to-b from-white/10 to-white/5 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <span className="flex h-5 w-5 items-center justify-center">
                {iconForHourly(current.icon, "hourly")}
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
