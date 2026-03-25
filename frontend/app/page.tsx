"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Bell, CloudRain, CloudSun, Compass, Droplets, Home, Map, Menu, Radar, ShieldAlert, Sun, TriangleAlert, Wind, ChevronRight, MapPin, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";

/**
 * Page 1: Mobile Home screen
 *
 * Built to sit on top of your existing Cloudflare Worker.
 * Current live integration used here:
 * - GET /api/alerts
 *
 * Kept intentionally modular so page 2 (Forecast), page 3 (Radar), and page 4 (Alerts)
 * can reuse the same location + alert state + nav shell.
 */

type AlertSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | string;

type AlertItem = {
  id: string;
  stateCode: string;
  event: string;
  areaDesc: string;
  severity: AlertSeverity;
  status: string;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  sent: string;
  effective: string;
  onset: string;
  expires: string;
  updated: string;
  nwsUrl: string;
};

type AlertsResponse = {
  alerts: AlertItem[];
  lastPoll: string | null;
  syncError: string | null;
};

type SavedLocation = {
  mode: "geo" | "zip";
  label: string;
  zip?: string;
  lat?: number;
  lon?: number;
  city?: string;
  stateCode?: string;
};

type WeatherLocation = {
  lat: number;
  lon: number;
  city?: string | null;
  state?: string | null;
  label: string;
  timeZone?: string | null;
  gridId?: string | null;
  gridX?: number | null;
  gridY?: number | null;
  radarStation?: string | null;
};

type WeatherCurrent = {
  temp: number | null;
  feelsLike: number | null;
  temperatureF?: number | null;
  feelsLikeF?: number | null;
  condition: string;
  wind: string;
  humidity: number | null;
  uv: string;
};

type WeatherHourlyPoint = {
  label: string;
  temp: number | null;
  icon: "storm" | "sun" | "cloud" | "night";
  precip?: number;
  startTime?: string;
  temperatureF?: number | null;
  shortForecast?: string;
  precipitationChance?: number;
};

type WeatherResponse = {
  location: WeatherLocation;
  current: WeatherCurrent;
  hourly: WeatherHourlyPoint[];
  daily: any[];
  radar: {
    station: string | null;
    loopImageUrl: string | null;
    stillImageUrl: string | null;
    updated: string;
    summary: string;
  };
  updated: string;
};

type AlertState = "ACTIVE_ALERTS" | "NO_ALERTS";

type CurrentConditions = {
  temp: number;
  feelsLike: number;
  condition: string;
  wind: string;
  humidity: number;
  uv: string;
};

type HourlyPoint = {
  label: string;
  temp: number;
  icon: "storm" | "sun" | "cloud" | "night";
  precip?: number;
  startTime?: string;
};

const STORAGE_KEY = "lwa-location-v1";

const fallbackCurrent: CurrentConditions = {
  temp: 72,
  feelsLike: 75,
  condition: "Scattered Storms",
  wind: "S 18 mph",
  humidity: 64,
  uv: "6 (High)",
};

const fallbackHourly: HourlyPoint[] = [
  { label: "Now", temp: 72, icon: "storm", precip: 60 },
  { label: "4 PM", temp: 75, icon: "sun" },
  { label: "5 PM", temp: 74, icon: "sun" },
  { label: "6 PM", temp: 71, icon: "storm", precip: 40 },
  { label: "7 PM", temp: 68, icon: "cloud" },
  { label: "8 PM", temp: 65, icon: "night" },
];

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatTime(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

async function fetchWeather(lat: number, lon: number): Promise<WeatherResponse> {
  const res = await fetch(`${API_BASE}/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Unable to load weather.");
  }
  return data as WeatherResponse;
}

function formatRelative(value?: string | null) {
  if (!value) return "just now";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "recently";
  const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 min ago";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hr ago`;
}

function severityTone(severity?: string) {
  const value = String(severity || "").toLowerCase();
  if (value === "extreme" || value === "severe") {
    return {
      card: "from-red-700 via-red-600 to-red-900 border-red-400/40",
      badge: "bg-red-100 text-red-800 border-red-300",
      button: "bg-white text-red-700 hover:bg-red-50",
      soft: "bg-red-600/15 border-red-400/20 text-red-50",
    };
  }
  if (value === "moderate") {
    return {
      card: "from-orange-600 via-orange-500 to-amber-700 border-orange-300/40",
      badge: "bg-orange-100 text-orange-800 border-orange-300",
      button: "bg-white text-orange-700 hover:bg-orange-50",
      soft: "bg-orange-500/15 border-orange-300/20 text-orange-50",
    };
  }
  return {
    card: "from-blue-700 via-sky-600 to-cyan-700 border-sky-300/40",
    badge: "bg-sky-100 text-sky-800 border-sky-300",
    button: "bg-white text-sky-700 hover:bg-sky-50",
    soft: "bg-sky-500/15 border-sky-300/20 text-sky-50",
  };
}

function getAlertPriority(event: string) {
  const e = String(event || "").toLowerCase();

  if (e.includes("warning")) return 4;
  if (e.includes("watch")) return 3;
  if (e.includes("advisory")) return 2;
  if (e.includes("statement")) return 1;

  return 0;
}

function getSeverityPriority(severity?: string) {
  const s = String(severity || "").toLowerCase();

  if (s === "extreme") return 4;
  if (s === "severe") return 3;
  if (s === "moderate") return 2;
  if (s === "minor") return 1;

  return 0;
}

function sortAlerts(alerts: AlertItem[]) {
  return [...alerts].sort((a, b) => {
    const typeDelta = getAlertPriority(b.event) - getAlertPriority(a.event);
    if (typeDelta !== 0) return typeDelta;

    const severityDelta = getSeverityPriority(b.severity) - getSeverityPriority(a.severity);
    if (severityDelta !== 0) return severityDelta;

    const urgencyRank: Record<string, number> = {
      immediate: 3,
      expected: 2,
      future: 1,
      past: 0,
      unknown: 0,
    };

    const certaintyRank: Record<string, number> = {
      observed: 3,
      likely: 2,
      possible: 1,
      unlikely: 0,
      unknown: 0,
    };

    const urgencyDelta =
      (urgencyRank[String(b.urgency || "").toLowerCase()] || 0) -
      (urgencyRank[String(a.urgency || "").toLowerCase()] || 0);
    if (urgencyDelta !== 0) return urgencyDelta;

    const certaintyDelta =
      (certaintyRank[String(b.certainty || "").toLowerCase()] || 0) -
      (certaintyRank[String(a.certainty || "").toLowerCase()] || 0);
    if (certaintyDelta !== 0) return certaintyDelta;

    return new Date(a.expires || 0).getTime() - new Date(b.expires || 0).getTime();
  });
}

function dedupeArea(areaDesc: string) {
  const parts = areaDesc.split(";").map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 2) return areaDesc;
  return `${parts.slice(0, 2).join(", ")} +${parts.length - 2} more`;
}

function iconForHourly(icon: HourlyPoint["icon"]) {
  if (icon === "storm") return <CloudRain className="h-6 w-6" />;
  if (icon === "sun") return <CloudSun className="h-6 w-6" />;
  if (icon === "night") return <CloudSun className="h-6 w-6 opacity-70" />;
  return <CloudSun className="h-6 w-6" />;
}

function mapIcon(forecast = "") {
  const f = forecast.toLowerCase();

  if (f.includes("storm") || f.includes("thunder")) return "storm";
  if (f.includes("sun") || f.includes("clear")) return "sun";
  if (f.includes("night")) return "night";
  if (f.includes("cloud")) return "cloud";

  return "cloud";
}

function BottomNav({
  alertCount = 0,
  activeTab,
  onChangeTab,
}: {
  alertCount?: number;
  activeTab: "home" | "forecast" | "radar" | "alerts" | "more";
  onChangeTab: (tab: "home" | "forecast" | "radar" | "alerts" | "more") => void;
}) {
  type BottomNavTab = {
    key: "home" | "forecast" | "radar" | "alerts" | "more";
    label: string;
    icon: typeof Home;
    badge?: number;
  };

  const tabs: BottomNavTab[] = [
    { key: "home", label: "Home", icon: Home },
    { key: "forecast", label: "Forecast", icon: Sun },
    { key: "radar", label: "Radar", icon: Radar },
    { key: "alerts", label: "Alerts", icon: Bell, badge: alertCount },
    { key: "more", label: "More", icon: Menu },
  ];

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md px-3 pb-3">
      <div className="rounded-[26px] border border-white/10 bg-slate-950/90 px-2 py-2 shadow-2xl backdrop-blur-xl">
        <div className="grid grid-cols-5 gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => onChangeTab(tab.key)}
                className={cn(
                  "relative flex flex-col items-center justify-center rounded-2xl px-2 py-2 text-xs font-medium transition-all",
                  isActive
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/30"
                    : "text-slate-300 hover:bg-white/5"
                )}
              >
                <div className="relative">
                  <Icon className="mb-1 h-[18px] w-[18px]" />
                  {tab.badge ? (
                    <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {tab.badge}
                    </span>
                  ) : null}
                </div>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LocationPrompt({
  onUseGeo,
  onUseZip,
  defaultToZip = false,
}: {
  onUseGeo: () => void;
  onUseZip: (zip: string) => void;
  defaultToZip?: boolean;
}) {
  const [zip, setZip] = useState("");
  const [showZip, setShowZip] = useState(defaultToZip);

  useEffect(() => {
    if (defaultToZip) setShowZip(true);
  }, [defaultToZip]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-4">
      <div className="w-full max-w-sm rounded-[28px] border border-white/10 bg-slate-900 p-5 text-white shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/20 text-blue-300">
          <MapPin className="h-6 w-6" />
        </div>

        <h2 className="text-xl font-bold">Enable location for local weather alerts?</h2>
        <p className="mt-2 text-sm text-slate-300">
          Use your location for nearby alerts, local conditions, and faster radar targeting.
        </p>

        {!showZip ? (
          <div className="mt-5 space-y-3">
            <Button
              className="h-11 w-full rounded-2xl bg-blue-600 text-white hover:bg-blue-500"
              onClick={onUseGeo}
            >
              Allow Location
            </Button>

            <Button
              variant="outline"
              className="h-11 w-full rounded-2xl border-white/15 bg-transparent text-white hover:bg-white/5"
              onClick={() => setShowZip(true)}
            >
              Enter ZIP Code Instead
            </Button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <Input
              inputMode="numeric"
              maxLength={5}
              placeholder="Enter ZIP Code"
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="h-11 rounded-2xl border-white/10 bg-slate-800 text-white placeholder:text-slate-400"
            />

            <Button
              className="h-11 w-full rounded-2xl bg-blue-600 text-white hover:bg-blue-500"
              onClick={() => zip.length === 5 && onUseZip(zip)}
              disabled={zip.length !== 5}
            >
              Save ZIP Code
            </Button>

            <button
              type="button"
              className="w-full text-sm text-slate-400"
              onClick={() => setShowZip(false)}
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function heroAreaLabel(alert: AlertItem) {
  const first = alert.areaDesc?.split(";")[0]?.trim() || "Your Area";
  return first.replace(/\b(County|Parish|Area)\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

function heroThreats(alert: AlertItem) {
  const text = `${alert.headline || ""} ${alert.description || ""}`.toLowerCase();
  const threats: string[] = [];

  if (text.includes("minor flooding")) threats.push("Minor Flooding");
  if (text.includes("flood stage")) threats.push("Near Flood Stage");
  if (text.includes("river is expected to rise")) threats.push("River Rising");
  if (text.includes("wind")) threats.push("70 MPH Winds");
  if (text.includes("hail")) threats.push("Large Hail");
  if (text.includes("flood")) threats.push("Flooding");
  if (text.includes("tornado")) threats.push("Rotation Possible");

  if (threats.length === 0) threats.push(alert.event);
  return threats.slice(0, 3);
}

function SingleSecondaryAlertCard({
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
      className={`w-full rounded-[18px] border border-white/10 bg-gradient-to-br ${smallAlertTone(
        alert.event
      )} p-4 text-left text-white shadow-lg`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-white/90">
            {alert.event}
          </div>
          <div className="mt-2 text-xl font-black leading-tight">{heroAreaLabel(alert)}</div>
          <div className="mt-2 text-sm font-semibold text-white/90">Until {formatTime(alert.expires)}</div>
        </div>

        <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-white/90" />
      </div>
    </button>
  );
}

function getAlertCTA(event: string) {
  const e = event.toLowerCase();

  if (e.includes("tornado")) return "TAKE COVER NOW";
  if (e.includes("severe thunderstorm")) return "MOVE INDOORS";
  if (e.includes("flash flood")) return "AVOID FLOODED AREAS";
  if (e.includes("flood")) return "MOVE TO HIGHER GROUND";
  if (e.includes("winter")) return "AVOID TRAVEL";
  if (e.includes("heat")) return "STAY COOL";
  if (e.includes("fire")) return "EVACUATE IF ADVISED";

  return "STAY ALERT";
}

function getAlertColor(event: string) {
  const e = event.toLowerCase();

  if (e.includes("warning")) return "red";
  if (e.includes("watch")) return "orange";
  if (e.includes("advisory")) return "yellow";
  if (e.includes("statement")) return "blue";

  return "red";
}

function getAlertBackground(event: string) {
  const e = event.toLowerCase();

  const isWarning = e.includes("warning");
  const isWatch = e.includes("watch");
  const isAdvisory = e.includes("advisory");

  if (isWarning) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,120,120,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,0,0,0.25), rgba(40,0,0,0.9)),
      linear-gradient(120deg, #5a0000 0%, #9a0000 40%, #390000 100%)
    `;
  }

  if (isWatch) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,180,0,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,60,0,0.3), rgba(60,30,0,0.9)),
      linear-gradient(120deg, #ff8c00 0%, #ff6a00 40%, #5a1a00 100%)
    `;
  }

  if (isAdvisory) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,230,120,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,100,0,0.3), rgba(60,50,0,0.9)),
      linear-gradient(120deg, #eab308 0%, #facc15 40%, #a16207 100%)
    `;
  }

  return `
    radial-gradient(circle at 70% 40%, rgba(120,200,255,0.25), transparent 20%),
    linear-gradient(180deg, rgba(0,40,80,0.4), rgba(0,20,50,0.9)),
    linear-gradient(120deg, #0b3a5c 0%, #1f6fa5 40%, #09263f 100%)
  `;
}

function getHeroVariant(event: string): "tornado" | "flood" | "winter" | "fire" | "default" {
  const e = event.toLowerCase();

  if (e.includes("tornado") || e.includes("severe thunderstorm")) return "tornado";
  if (e.includes("flood")) return "flood";
  if (e.includes("winter") || e.includes("snow") || e.includes("ice") || e.includes("blizzard")) return "winter";
  if (e.includes("fire") || e.includes("red flag") || e.includes("smoke")) return "fire";

  return "default";
}

function getHeroVariantStyles(variant: ReturnType<typeof getHeroVariant>) {
  switch (variant) {
    case "tornado":
      return {
        wrapper: "border-red-500/30 bg-[#140608]",
        topBar: "bg-red-700",
        title: "text-[2.2rem] leading-[0.92]",
        subtitle: "text-white/95",
        cta: "bg-white text-red-700 hover:bg-red-50",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };

    case "flood":
      return {
        wrapper: "border-red-500/25 bg-[#12090a]",
        topBar: "bg-red-600",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-white/95",
        cta: "bg-slate-950/55 text-white hover:bg-slate-900/70",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };

    case "winter":
      return {
        wrapper: "border-blue-200/25 bg-[#0c1520]",
        topBar: "bg-blue-700",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-slate-100",
        cta: "bg-white/90 text-slate-900 hover:bg-white",
        details: "bg-sky-600 hover:bg-sky-500 text-white",
      };

    case "fire":
      return {
        wrapper: "border-orange-400/25 bg-[#1a0d05]",
        topBar: "bg-orange-600",
        title: "text-[2.1rem] leading-[0.94]",
        subtitle: "text-orange-50",
        cta: "bg-white text-orange-700 hover:bg-orange-50",
        details: "bg-orange-500 hover:bg-orange-400 text-white",
      };

    default:
      return {
        wrapper: "border-red-500/25 bg-[#13090a]",
        topBar: "bg-red-600",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-white/95",
        cta: "bg-white text-red-700 hover:bg-red-50",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
  }
}

function BigAlertHero({
  alert,
  onPrimaryAction,
  onViewDetails,
}: {
  alert: AlertItem;
  onPrimaryAction: (alert: AlertItem) => void;
  onViewDetails: (alert: AlertItem) => void;
}) {
  const area = heroAreaLabel(alert);
  const threats = heroThreats(alert);
  const variant = getHeroVariant(alert.event);
  const styles = getHeroVariantStyles(variant);

  const subtitle =
    variant === "flood"
      ? "RIVER FLOODING"
      : variant === "winter"
      ? "HAZARDOUS WINTER WEATHER"
      : "& SURROUNDING AREAS";

  return (
    <div className={cn("overflow-hidden rounded-[22px] border shadow-2xl", styles.wrapper)}>
      <div className={cn("px-3 py-2 text-sm font-black uppercase tracking-wide text-white", styles.topBar)}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4" />
          {alert.event}
        </div>
      </div>

      <div className="relative min-h-[250px] overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background: getAlertBackground(alert.event),
          }}
        />

        {variant === "tornado" && (
          <>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.05),rgba(0,0,0,0.55))]" />
            <div className="absolute right-16 top-8 h-28 w-[2px] bg-white/85 blur-[1px]" />
            <div className="absolute right-20 top-20 h-20 w-[2px] rotate-[22deg] bg-white/70 blur-[1px]" />
            <div className="absolute right-28 top-16 h-16 w-[2px] -rotate-[25deg] bg-white/55 blur-[1px]" />
            <div className="absolute right-10 top-10 h-24 w-24 rounded-full bg-white/20 blur-2xl" />
          </>
        )}

        {variant === "flood" && (
          <>
            <div className="absolute inset-0 opacity-20 [background:radial-gradient(circle_at_center,rgba(255,255,255,0.2)_1px,transparent_1px)] [background-size:12px_12px]" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(80,160,255,0.18))]" />
          </>
        )}

        {variant === "winter" && (
          <>
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(rgba(255,255,255,0.8)_1px,transparent_1px)] [background-size:14px_14px]" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.08))]" />
          </>
        )}

        {variant === "fire" && (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_30%,rgba(255,190,60,0.25),transparent_14%)]" />
            <div className="absolute right-10 top-10 h-20 w-20 rounded-full bg-orange-300/25 blur-2xl" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(255,120,0,0.16))]" />
          </>
        )}

        {variant === "default" && (
          <div className="absolute inset-0 opacity-20 animate-pulse bg-[radial-gradient(circle_at_80%_30%,rgba(255,255,255,0.15),transparent_20%)]" />
        )}

        <div className="relative flex min-h-[250px] flex-col justify-between p-4">
          <div>
            <div className={cn("font-black tracking-tight text-white", styles.title)}>
              {area}
            </div>
            <div className={cn("mt-1 text-lg font-extrabold leading-none", styles.subtitle)}>
              {subtitle}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm font-bold text-white">
              {threats.map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-white/90" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onPrimaryAction(alert)}
              className={cn("mt-4 inline-flex rounded-lg px-3 py-2 text-sm font-black text-white shadow-lg hover:bg-black/40", styles.cta)}
            >
              {getAlertCTA(alert.event)}
            </button>
          </div>

          <div className="mt-4 flex items-end justify-between gap-3">
            <div className="rounded-lg bg-black/35 px-3 py-2 text-sm font-bold text-white">
              Until {formatTime(alert.expires)}
            </div>
            <Button
              className={cn("h-10 rounded-lg px-5 font-black", styles.details)}
              onClick={() => onViewDetails(alert)}
            >
              View Details
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function smallAlertTone(event: string) {
  const level = getAlertColor(event);

  if (level === "red") return "from-red-600 to-red-800";
  if (level === "orange") return "from-orange-500 to-orange-700";
  if (level === "yellow") return "from-yellow-400 to-yellow-600";
  if (level === "blue") return "from-blue-500 to-blue-700";

  return "from-red-600 to-red-800";
}

function SmallAlertCard({
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
      className={`min-w-[140px] rounded-[16px] border border-white/10 bg-gradient-to-br ${smallAlertTone(
        alert.event
      )} p-3 text-left text-white shadow-lg`}
    >
      <div className="text-[10px] font-black uppercase leading-4 tracking-wide">
        {alert.event}
      </div>
      <div className="mt-2 line-clamp-2 text-base font-black leading-tight">
        {heroAreaLabel(alert)}
      </div>
      <div className="mt-2 text-xs font-semibold text-white/90">
        Until {formatTime(alert.expires)}
      </div>
    </button>
  );
}

function CurrentConditionsCard({
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
            <CloudSun className="mx-auto h-16 w-16 text-yellow-300" />
            <div className="mt-4 text-6xl font-black leading-none">{current.temp}°</div>
            <div className="mt-2 text-sm font-medium text-blue-100">
              Feels like {current.feelsLike}°
            </div>
          </div>

          <div className="space-y-4 rounded-[24px] bg-white/5 p-4">
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <CloudRain className="h-5 w-5 text-sky-300" />
              {current.condition}
            </div>

            <div className="grid grid-cols-1 gap-3 text-sm font-medium text-blue-100">
              <div className="flex items-center gap-2">
                <Wind className="h-4 w-4" />
                {current.wind}
              </div>
              <div className="flex items-center gap-2">
                <Droplets className="h-4 w-4" />
                Humidity {current.humidity}%
              </div>
              <div className="flex items-center gap-2">
                <Sun className="h-4 w-4" />
                UV {current.uv}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HourlyStrip({
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
          <div className="text-xl font-black uppercase tracking-wide">Hourly Forecast</div>
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
            
              <div className="text-xs font-extrabold uppercase tracking-wide text-slate-200">
                {point.label}
              </div>
              <div className="mt-3 flex justify-center text-blue-100">
                {iconForHourly(point.icon)}
              </div>
              <div className="mt-3 text-4xl font-black leading-none">
                {Number.isFinite(point.temp) ? `${point.temp}°` : "—"}
              </div>
              <div className="mt-2 text-xs font-semibold text-slate-300">
                {point.precip ? `${point.precip}%` : "\u00A0"}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RadarPreviewCard({
  alertState,
  radar,
  onViewRadar,
}: {
  alertState: AlertState;
  radar: WeatherResponse['radar'] | null;
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
              {alertState === "ACTIVE_ALERTS" ? "Storm moving NE" : "Quiet in your area"}
            </div>
            <div className="mt-3 text-xs font-medium leading-5 text-slate-300">
              Updated 2 min ago
            </div>
          </div>

<div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-slate-900">
  {radar?.stillImageUrl ? (
    <img
      src={radar.stillImageUrl}
      alt="Live radar"
      className="absolute inset-0 h-full w-full object-cover"
    />
  ) : (
    <>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_60%_25%,rgba(255,196,0,0.35),transparent_18%),linear-gradient(135deg,rgba(34,197,94,0.35),transparent_25%),linear-gradient(160deg,rgba(250,204,21,0.28),transparent_45%),linear-gradient(200deg,rgba(239,68,68,0.4),transparent_62%),linear-gradient(180deg,#162033_0%,#101827_100%)]" />
      <div className="absolute inset-0 bg-gradient-to-br from-green-500/20 via-yellow-400/20 to-red-500/30 blur-[20px] opacity-40" />
      <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:18px_18px]" />
    </>
  )}
  <div className="relative flex h-full min-h-[96px] items-end justify-end p-3">
    <Button
      className="rounded-xl bg-blue-600 px-4 font-bold text-white hover:bg-blue-500"
      onClick={onViewRadar}
    >
      View Radar
    </Button>
  </div>
</div>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertHeadlineList({
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
          {alerts.slice(0, 4).map((alert) => (
            <button
              key={alert.id}
              type="button"
              onClick={() => onSelectAlert(alert)}
              className="flex w-full items-center justify-between rounded-[20px] border border-red-500/20 bg-gradient-to-r from-red-700 to-red-600 px-4 py-3 text-left shadow-lg"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-black uppercase tracking-wide text-white">{alert.event}</div>
                <div className="truncate text-sm text-red-50">{alert.headline || dedupeArea(alert.areaDesc)}</div>
              </div>
              <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-white" />
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AllClearBanner({
  locationLabel,
  lastPoll,
}: {
  locationLabel: string;
  lastPoll: string | null;
}) {
  return (
    <Card className="overflow-hidden rounded-[30px] border border-sky-300/20 bg-gradient-to-br from-sky-500 via-blue-600 to-blue-800 text-white shadow-2xl">
      <CardContent className="p-6">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em] text-white/90">
          <ShieldAlert className="h-4 w-4" />
          All Clear
        </div>
        <div className="mt-4 text-[2.6rem] font-black leading-[1.1] leading-tight">
          No active weather alerts
        </div>
        <div className="mt-3 text-sm font-medium text-sky-50">
          {locationLabel} • Updated {formatRelative(lastPoll)}
        </div>
      </CardContent>
    </Card>
  );
}

function openExternal(url?: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatAlertDate(value?: string) {
  if (!value) return "—";

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}):(\d{2})$/
  );

  if (!match) return value;

  const [, yearStr, monthStr, dayStr, hourStr, minute, offsetHour] = match;

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let hour = Number(hourStr);

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const weekday = weekdayNames[new Date(year, month - 1, day).getDay()];
  const monthName = monthNames[month - 1];

  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;

  return `${weekday}, ${monthName} ${day}, ${year}, ${hour}:${minute} ${ampm} (UTC${offsetHour})`;
}

function formatTimeLeft(expires?: string, whenText?: string | null) {
  if (whenText && whenText.toLowerCase().includes("until further notice")) {
    return "Ongoing";
  }

  if (!expires) return "—";

  const diff = new Date(expires).getTime() - Date.now();
  if (diff <= 0) return "Expired";

  const totalMin = Math.floor(diff / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

function cleanSectionText(value?: string | null) {
  if (!value) return null;
  return value
    .replace(/^\s+|\s+$/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBulletSection(description: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\*\\s*${escaped}\\.\\.\\.([\\s\\S]+?)(?=\\n\\n\\*\\s*[A-Z][A-Z\\s]+\\.\\.\\.|$)`,
    "i"
  );
  const match = description.match(regex);
  return cleanSectionText(match?.[1] || null);
}

function stripFloodIntro(description: string) {
  let text = description || "";

  text = text.replace(
    /^\.\.\.[\s\S]*?(?=\n\n\*\s*WHAT\.\.\.)/i,
    ""
  );

  return text.trim();
}

function parseAlertSections(alert: AlertItem) {
  const description = alert.description || "";
  const instruction = alert.instruction || "";

  const normalizedDescription = stripFloodIntro(description);

  // Standard warning style
  const hazardMatch = normalizedDescription.match(/(?:^|\n)HAZARD\.*\s*([\s\S]+?)(?:\n\n|(?:^|\n)SOURCE|(?:^|\n)IMPACT|$)/i);
  const sourceMatch = normalizedDescription.match(/(?:^|\n)SOURCE\.*\s*([\s\S]+?)(?:\n\n|(?:^|\n)IMPACT|$)/i);
  const impactMatch = normalizedDescription.match(/(?:^|\n)IMPACT\.*\s*([\s\S]+?)(?:\n\n|$)/i);

  // River / flood bulletin style
  const what = extractBulletSection(normalizedDescription, "WHAT");
  const where = extractBulletSection(normalizedDescription, "WHERE");
  const when = extractBulletSection(normalizedDescription, "WHEN");
  const impacts = extractBulletSection(normalizedDescription, "IMPACTS");
  const additionalDetails = extractBulletSection(normalizedDescription, "ADDITIONAL DETAILS");

  const cleanedDescription = cleanSectionText(
    normalizedDescription.replace(/\n\n\*\s*(WHAT|WHERE|WHEN|IMPACTS|ADDITIONAL DETAILS)\.\.\.[\s\S]*?(?=(\n\n\*\s*[A-Z][A-Z\s]+\.\.\.)|$)/gi, "")
  );

  return {
    description: cleanedDescription,
    hazard: cleanSectionText(hazardMatch?.[1] || null),
    source: cleanSectionText(sourceMatch?.[1] || null),
    impact: cleanSectionText(impactMatch?.[1] || null),

    what,
    where,
    when,
    impacts,
    additionalDetails,

    instruction: cleanSectionText(instruction),
  };
}

function AlertDetailsSheet({
  alert,
  onClose,
}: {
  alert: AlertItem;
  onClose: () => void;
}) {
  const sections = parseAlertSections(alert);
  const primaryRiverPoint = sections.where?.trim() || null;

  return (
    <div className="fixed inset-0 z-[120] bg-slate-950/70 backdrop-blur-sm">
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-[28px] border border-white/10 bg-white text-slate-900 shadow-2xl">
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-black uppercase tracking-wide text-red-600">
                {alert.event}
              </div>
              <div className="mt-1 text-2xl font-black leading-tight">
                {heroAreaLabel(alert)}
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
            >
              Close
            </button>
          </div>

          {primaryRiverPoint ? (
            <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="font-black uppercase text-slate-500">Primary River Point</div>
              <div className="mt-1 font-medium text-slate-900">{primaryRiverPoint}</div>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <div>
              <div className="font-black uppercase text-slate-500">Issued</div>
              <div className="mt-1 font-medium">{formatAlertDate(alert.sent)}</div>
            </div>
            <div>
              <div className="font-black uppercase text-slate-500">Expires</div>
              <div className="mt-1 font-medium">{formatAlertDate(alert.expires)}</div>
            </div>
            <div>
              <div className="font-black uppercase text-slate-500">Time Left</div>
              <div className="mt-1 font-medium">{formatTimeLeft(alert.expires, sections.when)}</div>
            </div>
          </div>

          <div className="mt-5 space-y-4 text-sm leading-6">
            <div>
              <div className="font-black uppercase text-slate-500">Affected Areas</div>
              <div className="mt-1">{alert.areaDesc || "—"}</div>
            </div>

            {sections.description &&
            !(sections.what || sections.where || sections.when || sections.impacts || sections.additionalDetails) ? (
              <div>
                <div className="font-black uppercase text-slate-500">Description</div>
                <div className="mt-1 whitespace-pre-line">{sections.description}</div>
              </div>
            ) : null}

            {sections.what ? (
              <div>
                <div className="font-black uppercase text-slate-500">What</div>
                <div className="mt-1 whitespace-pre-line">{sections.what}</div>
              </div>
            ) : null}

            {sections.when ? (
              <div>
                <div className="font-black uppercase text-slate-500">When</div>
                <div className="mt-1 whitespace-pre-line">{sections.when}</div>
              </div>
            ) : null}

            {sections.impacts ? (
              <div>
                <div className="font-black uppercase text-slate-500">Impacts</div>
                <div className="mt-1 whitespace-pre-line">{sections.impacts}</div>
              </div>
            ) : null}

            {sections.additionalDetails ? (
              <div>
                <div className="font-black uppercase text-slate-500">Additional Details</div>
                <div className="mt-1 whitespace-pre-line">{sections.additionalDetails}</div>
              </div>
            ) : null}

            {sections.hazard ? (
              <div>
                <div className="font-black uppercase text-slate-500">Hazard</div>
                <div className="mt-1 whitespace-pre-line">{sections.hazard}</div>
              </div>
            ) : null}

            {sections.source ? (
              <div>
                <div className="font-black uppercase text-slate-500">Source</div>
                <div className="mt-1 whitespace-pre-line">{sections.source}</div>
              </div>
            ) : null}

{sections.impact && !sections.impacts ? (
              <div>
                <div className="font-black uppercase text-slate-500">Impact</div>
                <div className="mt-1 whitespace-pre-line">{sections.impact}</div>
              </div>
            ) : null}

            {sections.instruction ? (
              <div>
                <div className="font-black uppercase text-slate-500">Instructions</div>
                <div className="mt-1 whitespace-pre-line">{sections.instruction}</div>
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <Button
              className="w-full rounded-2xl bg-blue-600 font-bold text-white hover:bg-blue-500"
              onClick={() => openExternal(alert.nwsUrl)}
            >
              View official NWS alert
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LiveWeatherAlertsHomePage() {
  const [location, setLocation] = useState<SavedLocation | null>(null);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  const [promptDefaultToZip, setPromptDefaultToZip] = useState(false);
  const [alertsResp, setAlertsResp] = useState<AlertsResponse | null>(null);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"home" | "forecast" | "radar" | "alerts" | "more">("home");
  const [selectedAlert, setSelectedAlert] = useState<AlertItem | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    console.log("STORAGE_KEY", STORAGE_KEY);
    console.log("raw location", raw);

    if (!raw) {
      setShowLocationPrompt(true);
      return;
    }
    try {
      setLocation(JSON.parse(raw));
    } catch {
      setShowLocationPrompt(true);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function run() {
      if (!location?.lat || !location?.lon) {
        return;
      }

      setLoadingWeather(true);
      setWeatherError(null);

      try {
        const data = await fetchWeather(location.lat, location.lon);
        if (active) {
          setWeather(data);
          if (data.location?.label) {
            setLocation((prev) => {
              if (!prev) return prev;

              const nextLabel = prev.mode === "zip" ? prev.label : data.location.label;
              const nextCity = data.location.city ?? undefined;
              const nextStateCode = data.location.state ?? undefined;

              if (
                prev.label === nextLabel &&
                prev.city === nextCity &&
                prev.stateCode === nextStateCode
              ) {
                return prev;
              }

              return {
                ...prev,
                label: nextLabel,
                city: nextCity,
                stateCode: nextStateCode,
              };
            });
          }
        }
      } catch (err) {
        if (active) {
          setWeatherError(err instanceof Error ? err.message : "Unable to load weather.");
        }
      } finally {
        if (active) setLoadingWeather(false);
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [location?.lat, location?.lon]);

  useEffect(() => {
    let active = true;
    async function run() {
      setLoadingAlerts(true);
      try {
        const res = await fetch(`${API_BASE}/api/alerts`, { cache: "no-store" });
        const data: AlertsResponse = await res.json();
        if (active) {
          const filtered = location?.stateCode
            ? data.alerts.filter((a) => a.stateCode === location.stateCode)
            : data.alerts;
          setAlertsResp({ ...data, alerts: filtered });
        }
      } catch {
        if (active) {
          setAlertsResp({ alerts: [], lastPoll: null, syncError: "Unable to load alerts." });
        }
      } finally {
        if (active) setLoadingAlerts(false);
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [location?.stateCode]);

  const sortedAlerts = useMemo(() => sortAlerts(alertsResp?.alerts || []), [alertsResp]);

  const filteredAlerts = useMemo(() => {
    if (!location?.stateCode) return sortedAlerts;
    const inState = sortedAlerts.filter((item) => item.stateCode === location.stateCode);
    return inState.length > 0 ? inState : sortedAlerts;
  }, [location, sortedAlerts]);

  const alertState: AlertState = filteredAlerts.length > 0 ? "ACTIVE_ALERTS" : "NO_ALERTS";
  const heroAlert =
    filteredAlerts.find((a) => getAlertPriority(a.event) >= 2) ||
    filteredAlerts[0] ||
    null;
  const secondaryAlerts = filteredAlerts.filter((a) => a !== heroAlert).slice(0, 3);
  const locationLabel = location?.label || "Your Area";

  const currentConditions: CurrentConditions = {
    temp: weather?.current?.temperatureF ?? fallbackCurrent.temp,
    feelsLike: weather?.current?.feelsLikeF ?? fallbackCurrent.feelsLike,
    condition: weather?.current?.condition || fallbackCurrent.condition,
    wind: weather?.current?.wind || fallbackCurrent.wind,
    humidity: weather?.current?.humidity ?? fallbackCurrent.humidity,
    uv: weather?.current?.uv || fallbackCurrent.uv,
  };

  async function handleUseGeo() {
    if (!("geolocation" in navigator)) {
      alert("Geolocation is not supported in this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const saved: SavedLocation = {
          mode: "geo",
          label: "Current Location",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        setLocation(saved);
        setPromptDefaultToZip(false);
        setShowLocationPrompt(false);
      },
      (err) => {
        console.error("Geolocation error code:", err.code);
        console.error("Geolocation error message:", err.message);

        const reason =
          err.code === 1
            ? "Location permission was denied."
            : err.code === 2
            ? "Location is unavailable right now. Try ZIP code instead."
            : err.code === 3
            ? "Location request timed out. Try again or use ZIP code instead."
            : "Unknown geolocation error.";

        alert(reason);
        setShowLocationPrompt(true);
        // Switch to ZIP input so users can easily fall back
        setPromptDefaultToZip(true);
      },
      {
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 300000,
      }
    );
  }

  async function handleUseZip(zip: string) {
    try {
      const res = await fetch(`${API_BASE}/api/location?zip=${encodeURIComponent(zip)}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Unable to find ZIP code.");
      }

      const saved: SavedLocation = {
        mode: "zip",
        label: data.label || `ZIP ${zip}`,
        zip,
        lat: data.lat,
        lon: data.lon,
        stateCode: data.state || undefined,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setLocation(saved);
      setShowLocationPrompt(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "ZIP lookup failed.");
    }
  }

  function renderHomeTab() {
    return (
      <div className="space-y-4">
        {alertState === "ACTIVE_ALERTS" && heroAlert ? (
          <>
            <BigAlertHero
              alert={heroAlert}
              onPrimaryAction={(alert) => openExternal(alert.nwsUrl)}
              onViewDetails={(alert) => setSelectedAlert(alert)}
            />

            {secondaryAlerts.length === 1 ? (
              <div className="space-y-2">
                <div className="px-1 text-xs font-black uppercase tracking-[0.18em] text-slate-300">
                  Related Alert
                </div>
                <SingleSecondaryAlertCard
                  alert={secondaryAlerts[0]}
                  onClick={(alert) => setSelectedAlert(alert)}
                />
              </div>
            ) : secondaryAlerts.length > 1 ? (
              <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
                {secondaryAlerts.slice(0, 3).map((alert) => (
                  <SmallAlertCard
                    key={alert.id}
                    alert={alert}
                    onClick={(alert) => setSelectedAlert(alert)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <AllClearBanner
            locationLabel={locationLabel}
            lastPoll={alertsResp?.lastPoll ?? null}
          />
        )}

        <CurrentConditionsCard
          current={currentConditions}
          locationLabel={locationLabel}
        />

        <div id="forecast-section">
          <HourlyStrip
            points={
              weather?.hourly?.length
                ? weather.hourly.map((p, i) => ({
                    label:
                      i === 0
                        ? "Now"
                        : new Date(p.startTime || Date.now()).toLocaleTimeString([], {
                            hour: "numeric",
                          }),
                    temp: p.temperatureF ?? 0,
                    icon: mapIcon(p.shortForecast),
                    precip: p.precipitationChance ?? 0,
                    startTime: p.startTime,
                  }))
                : fallbackHourly
            }
            onView10Day={() => setActiveTab("forecast")}
          />
        </div>

        <div id="radar-section">
          <RadarPreviewCard
            alertState={alertState}
            radar={weather?.radar || null}
            onViewRadar={() => setActiveTab("radar")}
          />
        </div>

        {alertState === "ACTIVE_ALERTS" ? (
          <div id="alerts-section">
            <AlertHeadlineList
              alerts={filteredAlerts}
              onSelectAlert={(alert) => setSelectedAlert(alert)}
            />
          </div>
        ) : (
          <Card className="rounded-[30px] border border-sky-300/15 bg-gradient-to-br from-sky-900/80 to-blue-950 text-white shadow-xl">
            <CardContent className="p-5">
              <div className="text-xl font-black uppercase tracking-wide">What to Watch</div>
              <div className="mt-4 space-y-3 text-sm font-medium leading-6 text-sky-100">
                <div>• Quiet conditions nearby right now</div>
                <div>• Check radar again before evening plans</div>
                <div>• Enable alerts for faster warning coverage</div>
              </div>
              <Button className="mt-6 h-11 w-full rounded-2xl bg-blue-600 font-bold hover:bg-blue-500">
                Get notified when conditions change
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  function renderForecastTab() {
    return (
      <div className="space-y-4">
        <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-xl font-black uppercase tracking-wide">10-Day Forecast</div>
              <div className="text-sm text-slate-400">{locationLabel}</div>
            </div>

            <div className="mt-5 space-y-3">
              {(weather?.daily || []).slice(0, 10).map((day: any, idx: number) => (
                <div
                  key={`${day?.name || "day"}-${idx}`}
                  className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-4"
                >
                  <div>
                    <div className="text-sm font-bold text-white">
                      {day?.name || `Day ${idx + 1}`}
                    </div>
                    <div className="mt-1 text-sm text-slate-300">
                      {day?.shortForecast || day?.detailedForecast || "Forecast unavailable"}
                    </div>
                  </div>

                  <div className="ml-4 text-right">
                    <div className="text-2xl font-black text-white">
                      {day?.temperatureF ?? day?.temperature ?? "—"}°
                    </div>
                  </div>
                </div>
              ))}

              {(!weather?.daily || weather.daily.length === 0) && (
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-slate-300">
                  Forecast data is unavailable right now.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  function renderRadarTab() {
    return (
      <div className="space-y-4">
        <RadarPreviewCard
          alertState={alertState}
          radar={weather?.radar || null}
          onViewRadar={() => {}}
        />

        <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="text-xl font-black uppercase tracking-wide">Radar Details</div>
            <div className="mt-4 text-sm text-slate-300">
              {weather?.radar?.summary || "Live radar view for your area."}
            </div>
            <div className="mt-3 text-sm text-slate-400">
              Updated {formatRelative(weather?.radar?.updated || weather?.updated)}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  function renderAlertsTab() {
    return (
      <div className="space-y-4">
        {filteredAlerts.length > 0 ? (
          filteredAlerts.map((alert) => (
            <button
              key={alert.id}
              type="button"
              onClick={() => setSelectedAlert(alert)}
              className="w-full rounded-[22px] border border-red-500/20 bg-gradient-to-r from-red-700 to-red-600 px-4 py-4 text-left text-white shadow-lg"
            >
              <div className="text-xs font-black uppercase tracking-wide text-red-50">
                {alert.event}
              </div>
              <div className="mt-2 text-xl font-black leading-tight">
                {heroAreaLabel(alert)}
              </div>
              <div className="mt-2 text-sm text-red-50/90">
                Until {formatTime(alert.expires)}
              </div>
            </button>
          ))
        ) : (
          <Card className="rounded-[30px] border border-sky-300/15 bg-gradient-to-br from-sky-900/80 to-blue-950 text-white shadow-xl">
            <CardContent className="p-5">
              <div className="text-xl font-black uppercase tracking-wide">No Active Alerts</div>
              <div className="mt-3 text-sm text-sky-100">
                There are no active alerts for this location right now.
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#081122_0%,#0b1730_30%,#07101d_100%)] text-white">
      <div className="mx-auto max-w-md px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4">
        <motion.header initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} className="mb-4 flex items-center justify-between rounded-[26px] border border-white/10 bg-slate-950/70 px-4 py-3 shadow-xl backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-red-600 shadow-lg shadow-red-600/30">
              <Bell className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-lg font-black uppercase tracking-tight">Live Weather Alerts</div>
              <div className="text-xs text-slate-400">{loadingAlerts ? "Loading alerts..." : `Synced ${formatRelative(alertsResp?.lastPoll)}`}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-slate-300">
            <button
              type="button"
              className="rounded-xl p-2 hover:bg-white/5"
              onClick={() => setActiveTab("radar")}
              aria-label="Go to radar"
            >
              <Map className="h-5 w-5" />
            </button>

            <button
              type="button"
              className="rounded-xl p-2 hover:bg-white/5"
              onClick={() => setShowLocationPrompt(true)}
              aria-label="Open location settings"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </motion.header>

        <div className="space-y-4">
          {activeTab === "home" && renderHomeTab()}
          {activeTab === "forecast" && renderForecastTab()}
          {activeTab === "radar" && renderRadarTab()}
          {activeTab === "alerts" && renderAlertsTab()}

          {alertsResp?.syncError ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {alertsResp.syncError}
            </div>
          ) : null}
        </div>
      </div>

      <BottomNav
        alertCount={filteredAlerts.length}
        activeTab={activeTab}
        onChangeTab={(tab) => {
          if (tab === "more") {
            setShowLocationPrompt(true);
            return;
          }

          setActiveTab(tab);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      {selectedAlert ? (
        <AlertDetailsSheet
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      ) : null}

      {showLocationPrompt ? (
        <LocationPrompt onUseGeo={handleUseGeo} onUseZip={handleUseZip} defaultToZip={promptDefaultToZip} />
      ) : null}
    </div>
  );
}
