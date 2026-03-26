"use client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Map,
  Menu,
  Radar,
  ShieldAlert,
  TriangleAlert,
  CloudRain,
  CloudFog,
  Waves,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import RadarPreviewCard from "@/components/weather/RadarPreviewCard";
import CurrentConditionsCard from "@/components/weather/CurrentConditionsCard";
import HourlyStrip from "@/components/weather/HourlyStrip";
import AlertDetailsSheet from "@/components/alerts/AlertDetailsSheet";
import BottomNav from "@/components/navigation/BottomNav";
import LocationPrompt from "@/components/location/LocationPrompt";
import RadarMapModal from "@/components/RadarMapModal";
import NotificationPrompt from "@/components/location/NotificationPrompt";
import BigAlertHero from "@/components/alerts/BigAlertHero";
import GroupedAlertsList from "@/components/alerts/GroupedAlertsList";
import { motion } from "framer-motion";

import { cn, openExternal } from "@/lib/utils";
import { fetchWeather, safeJson } from "@/lib/api/client";
import {
  buildDefaultPushPreferences,
  getPushStatus,
  subscribeToPush,
  unsubscribeFromPush,
  updatePushPreferences,
  type PushPreferences,
} from "@/lib/push";
import {
  formatTime,
  formatLiveTime,
  isNightForHour,
  resolveWeatherIcon,
} from "@/lib/weather/formatters";
import { sortAlerts, getAlertPriority, heroAreaLabel, getAlertBackground, getHeroVariantBackgroundImageIfExists } from "@/lib/alerts/helpers";

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
  countyFips?: string | null;
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

type AlertChangeType = "new" | "updated" | null;

type AlertLiveMeta = {
  changeType: AlertChangeType;
  detectedAt: number;
};

type AlertLiveMap = Record<string, AlertLiveMeta>;

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
  county?: string;
  countyFips?: string;
  adjacentCountyFips?: string[];
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
  sunrise?: string | null;
  sunset?: string | null;
  isNight?: boolean;
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

type DailyForecast = {
  name?: string;
  shortForecast?: string;
  detailedForecast?: string;
  highF?: number;
  temperatureF?: number;
  temperature?: number;
  lowF?: number;
  nightTemperature?: number;
  nightTemp?: number;
  precipitationChance?: number;
  pop?: number;
  wind?: string;
  windSpeed?: string;
};

type WeatherResponse = {
  location: WeatherLocation;
  current: WeatherCurrent;
  hourly: WeatherHourlyPoint[];
  daily: DailyForecast[];
  radar: {
    station: string | null;
    loopImageUrl?: string | null;
    stillImageUrl?: string | null;
    updated?: string;
    summary?: string;
    frames?: { time: string; label: string }[];
    tileTemplate?: string | null;
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
  icon: "storm" | "sun" | "cloud" | "night";
  sunrise?: string | null;
  sunset?: string | null;
  isNight?: boolean;
};

type HourlyPoint = {
  label: string;
  temp: number;
  icon: "storm" | "sun" | "cloud" | "night";
  precip?: number;
  startTime?: string;
  shortForecast?: string;
};

const STORAGE_KEY = "lwa-location-v1";
const HOME_LOCATION_KEY = "lwa-home-location-v1";
const TRAVEL_ALERTS_MODE_KEY = "lwa-travel-alerts-mode-v1";

const fallbackCurrent: CurrentConditions = {
  temp: 72,
  feelsLike: 75,
  condition: "Scattered Storms",
  wind: "S 18 mph",
  humidity: 64,
  uv: "6 (High)",
  icon: "storm",
  sunrise: null,
  sunset: null,
  isNight: false,
};

const fallbackHourly: HourlyPoint[] = [
  { label: "Now", temp: 72, icon: "storm", precip: 60 },
  { label: "4 PM", temp: 75, icon: "sun" },
  { label: "5 PM", temp: 74, icon: "sun" },
  { label: "6 PM", temp: 71, icon: "storm", precip: 40 },
  { label: "7 PM", temp: 68, icon: "cloud" },
  { label: "8 PM", temp: 65, icon: "night" },
];

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
const STORM_SPEED_MPH = 45;

function resolveWeatherBackground(
  condition: string | undefined,
  isNight: boolean | undefined,
): string {
  const text = String(condition || "").toLowerCase();

  const isStorm =
    text.includes("thunder") ||
    text.includes("storm") ||
    text.includes("tornado") ||
    text.includes("lightning");

  const isCloudy =
    text.includes("rain") ||
    text.includes("shower") ||
    text.includes("drizzle") ||
    text.includes("snow") ||
    text.includes("sleet") ||
    text.includes("ice") ||
    text.includes("freezing") ||
    text.includes("fog") ||
    text.includes("mist") ||
    text.includes("haze") ||
    text.includes("smoke") ||
    text.includes("cloud");

  if (isNight) {
    if (isStorm) return "/images/website/storm-night.jpg";
    if (isCloudy) return "/images/website/cloudy-night.jpg";
    return "/images/website/clear-night.jpg";
  }

  if (isStorm) return "/images/website/storm-day.jpg";
  if (isCloudy) return "/images/website/cloudy-day.jpg";
  return "/images/website/sunny-day.jpg";
}

function AllClearBanner({
  locationLabel,
  lastPoll,
  backgroundImage,
}: {
  locationLabel: string;
  lastPoll: number | null;
  backgroundImage?: string;
}) {
  return (
    <Card
      className="relative overflow-hidden rounded-[30px] border border-sky-300/20 text-white shadow-2xl"
      style={{
        backgroundImage: backgroundImage ? `url(${backgroundImage})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,18,34,0.18)_0%,rgba(8,18,34,0.38)_45%,rgba(8,18,34,0.62)_100%)]" />
      <CardContent className="relative p-6">
        <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.18em] text-white/90">
          <ShieldAlert className="h-4 w-4" />
          All Clear
        </div>
        <div className="mt-4 text-[2.6rem] font-black leading-[1.1] leading-tight">
          No active weather alerts
        </div>
        <div className="mt-3 text-sm font-medium text-sky-50">
          {locationLabel} • {formatLiveTime(lastPoll ? new Date(lastPoll).toISOString() : null)}
        </div>
      </CardContent>
    </Card>
  );
}

export default function LiveWeatherAlertsHomePage() {
  const NOTIFICATION_PROMPT_SEEN_KEY = "lwa-notification-prompt-seen-v1";

  const [location, setLocation] = useState<SavedLocation | null>(null);
  const [homeLocation, setHomeLocation] = useState<SavedLocation | null>(null);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  const [promptDefaultToZip, setPromptDefaultToZip] = useState(false);
  const [showNotificationPrompt, setShowNotificationPrompt] = useState(false);
  const [notificationPromptSeen, setNotificationPromptSeen] = useState(false);
  const [travelAlertsMode, setTravelAlertsMode] = useState<"off" | "follow" | "corridor">("off");
  const [lastTravelPosition, setLastTravelPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [travelBearing, setTravelBearing] = useState<number | null>(null);
  const [travelLocationUpdatedAt, setTravelLocationUpdatedAt] = useState<number | null>(null);
  const [countyCenters, setCountyCenters] = useState<Record<string, { lat: number; lon: number }>>({});
  const [alertsResp, setAlertsResp] = useState<AlertsResponse | null>(null);
  const [alertLiveMap, setAlertLiveMap] = useState<AlertLiveMap>({});
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [newAlertCount, setNewAlertCount] = useState(0);
  const [updatedAlertCount, setUpdatedAlertCount] = useState(0);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"home" | "forecast" | "radar" | "alerts" | "more">("home");
  const [selectedAlert, setSelectedAlert] = useState<AlertItem | null>(null);
  const [showRadarModal, setShowRadarModal] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<PushPreferences | null>(null);

  useEffect(() => {
    const savedTab = localStorage.getItem("ACTIVE_TAB") as
      | "home"
      | "forecast"
      | "radar"
      | "alerts"
      | "more"
      | null;

    const validTabs = ["home", "forecast", "radar", "alerts", "more"] as const;
    if (savedTab && validTabs.includes(savedTab)) {
      setActiveTab(savedTab);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ACTIVE_TAB", activeTab);
  }, [activeTab]);

  useEffect(() => {
    const seen = localStorage.getItem(NOTIFICATION_PROMPT_SEEN_KEY) === "true";
    setNotificationPromptSeen(seen);

    const savedTravelMode = localStorage.getItem(TRAVEL_ALERTS_MODE_KEY) as
      | "off"
      | "follow"
      | "corridor"
      | null;
    if (savedTravelMode) {
      setTravelAlertsMode(savedTravelMode);
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    console.log("STORAGE_KEY", STORAGE_KEY);
    console.log("raw location", raw);

    if (!raw) {
      setShowLocationPrompt(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as SavedLocation;
      setLocation(parsed);
      const homeRaw = localStorage.getItem(HOME_LOCATION_KEY);
      if (homeRaw) {
        setHomeLocation(JSON.parse(homeRaw));
      } else {
        setHomeLocation(parsed);
        localStorage.setItem(HOME_LOCATION_KEY, JSON.stringify(parsed));
      }
    } catch {
      setShowLocationPrompt(true);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function run() {
      try {
        const status = await getPushStatus();
        if (!active) return;

        setPushEnabled(status.enabled);

        if (status.prefs) {
          setPushPrefs(status.prefs);
        } else if (location?.stateCode) {
          setPushPrefs(buildDefaultPushPreferences(location.stateCode));
        }
      } catch {
        if (!active) return;
        setPushEnabled(false);
        if (location?.stateCode) {
          setPushPrefs(buildDefaultPushPreferences(location.stateCode));
        }
      }
    }

    run();
    return () => {
      active = false;
    };
  }, [location?.stateCode]);

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
    const refreshInterval = setInterval(() => {
      run();
    }, 2 * 60 * 1000); // refresh every 2 minutes for mobile and desktop

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        run();
      }
    };

    const onFocus = () => run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      active = false;
      clearInterval(refreshInterval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [location?.lat, location?.lon]);

  function didAlertChange(prev: AlertItem | undefined, next: AlertItem) {
    if (!prev) return "new" as const;

    if (
      prev.updated !== next.updated ||
      prev.expires !== next.expires ||
      prev.headline !== next.headline ||
      prev.description !== next.description ||
      prev.instruction !== next.instruction
    ) {
      return "updated" as const;
    }

    return null;
  }

  function buildAlertMap(alerts: AlertItem[]) {
    return Object.fromEntries(alerts.map((alert) => [alert.id, alert]));
  }

  function formatLiveStatusTime(ts?: number | null) {
    if (!ts) return "—";
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));

    if (diffSec < 10) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;

    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  }

  function getRiskTone(alerts: AlertItem[]) {
    if (!alerts.length) return "calm" as const;

    const highest = alerts.reduce((best, alert) => {
      const severity = String(alert.severity || "").toLowerCase();
      const event = String(alert.event || "").toLowerCase();

      const score =
        severity === "extreme" ? 4 :
        severity === "severe" ? 3 :
        severity === "moderate" ? 2 :
        severity === "minor" ? 1 : 0;

      const boostedScore =
        event.includes("tornado warning") ||
        event.includes("flash flood warning") ||
        event.includes("severe thunderstorm warning")
          ? Math.max(score, 3)
          : score;

      return boostedScore > best ? boostedScore : best;
    }, 0);

    if (highest >= 3) return "warning" as const;
    if (highest >= 1) return "watch" as const;
    return "calm" as const;
  }

  function getDynamicCta(tone: "calm" | "watch" | "warning") {
    if (tone === "warning") {
      return {
        button: "Severe Weather Active — Turn On Alerts NOW",
        subtext: "Get instant severe weather alerts before conditions worsen",
      };
    }

    if (tone === "watch") {
      return {
        button: "Storms Possible — Enable Alerts",
        subtext: "Get notified fast if watches or warnings are issued",
      };
    }

    return {
      button: "Turn On Weather Alerts",
      subtext: "Get instant severe weather alerts before conditions change",
    };
  }

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function run(showLoader = false) {
      if (showLoader) setLoadingAlerts(true);

      try {
        const res = await fetch(`${API_BASE}/api/alerts`, { cache: "no-store" });
        const data = (await safeJson(res)) as AlertsResponse & { error?: string };

        if (!res.ok) {
          throw new Error(data?.error || "Unable to load alerts.");
        }

        if (!active) return;

        const filtered = location?.stateCode
          ? data.alerts.filter((a) => a.stateCode === location.stateCode)
          : data.alerts;

        setAlertsResp((prev) => {
          const prevAlerts = prev?.alerts || [];
          const prevMap = buildAlertMap(prevAlerts);

          const liveChanges: AlertLiveMap = {};
          let newCount = 0;
          let updatedCount = 0;

          for (const alert of filtered) {
            const changeType = didAlertChange(prevMap[alert.id], alert);

            if (changeType) {
              liveChanges[alert.id] = {
                changeType,
                detectedAt: Date.now(),
              };

              if (changeType === "new") newCount += 1;
              if (changeType === "updated") updatedCount += 1;
            }
          }

          setAlertLiveMap((current) => ({
            ...current,
            ...liveChanges,
          }));
          setNewAlertCount(newCount);
          setUpdatedAlertCount(updatedCount);
          setLastCheckedAt(Date.now());

          return { ...data, alerts: filtered };
        });
      } catch {
        if (!active) return;
        setAlertsResp({ alerts: [], lastPoll: null, syncError: "Unable to load alerts." });
        setLastCheckedAt(Date.now());
      } finally {
        if (!active) return;
        setLoadingAlerts(false);

        timer = setTimeout(() => {
          run(false);
        }, 60000);
      }
    }

    run(true);

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [location?.stateCode]);

  useEffect(() => {
    const timer = setInterval(() => {
      setAlertLiveMap((current) => {
        const next: AlertLiveMap = {};
        const now = Date.now();

        for (const [id, meta] of Object.entries(current)) {
          if (now - meta.detectedAt < 10 * 60 * 1000) {
            next[id] = meta;
          }
        }

        return next;
      });
    }, 30000);

    return () => clearInterval(timer);
  }, []);

  const hasMovedEnough = useCallback(
    (prev: { lat?: number; lon?: number }, next: { lat: number; lon: number }) => {
      if (!prev.lat || !prev.lon) return true;
      const distance = getDistanceMiles({ lat: prev.lat, lon: prev.lon }, { lat: next.lat, lon: next.lon });
      return distance > 15;
    },
    []
  );

  async function updateLocationFromTravel(next: { lat: number; lon: number }) {
    const current = location;
    if (!current) return;

    const nextLocation: SavedLocation = {
      ...current,
      lat: next.lat,
      lon: next.lon,
    };

    try {
      const res = await fetch(`${API_BASE}/api/location?lat=${next.lat}&lon=${next.lon}`, {
        cache: "no-store",
      });
      const data = await safeJson(res);
      if (res.ok && data) {
        nextLocation.stateCode = data.state || nextLocation.stateCode;
        if (data.county) nextLocation.county = data.county;
        if (data.countyFips) nextLocation.countyFips = data.countyFips;
        if (Array.isArray(data.adjacentCountyFips)) nextLocation.adjacentCountyFips = data.adjacentCountyFips;
        if (data.label) nextLocation.label = data.label;

        if (data.countyCenters && typeof data.countyCenters === "object") {
          setCountyCenters((prev) => ({
            ...prev,
            ...data.countyCenters,
          }));
        }
        if (data.countyFips && data.countyCenter && data.countyCenter.lat && data.countyCenter.lon) {
          setCountyCenters((prev) => ({
            ...prev,
            [data.countyFips]: {
              lat: data.countyCenter.lat,
              lon: data.countyCenter.lon,
            },
          }));
        }

        if (nextLocation.countyFips && nextLocation.countyFips !== location?.countyFips) {
          openNotificationPromptIfNeeded(nextLocation);
        }
      }
    } catch {
      // keep existing values
    }

    setLocation(nextLocation);
    setTravelLocationUpdatedAt(Date.now());

    if (pushEnabled && pushPrefs && nextLocation.countyFips && nextLocation.countyFips !== (current?.countyFips || "")) {
      const nextPrefs = {
        ...pushPrefs,
        stateCode: nextLocation.stateCode || pushPrefs.stateCode,
        countyFips: nextLocation.countyFips,
      };
      try {
        await updatePushPreferences(nextPrefs);
        setPushPrefs(nextPrefs);
      } catch (err) {
        console.warn("Failed to update push preferences on travel location change", err);
      }
    }
  }

  const handleTravelLocationUpdate = useCallback(
    (next: { lat: number; lon: number }) => {
      if (!location?.lat || !location?.lon) return;
      if (!hasMovedEnough(location, next)) return;
      updateLocationFromTravel(next);
    },
    [location, updateLocationFromTravel, hasMovedEnough]
  );

  useEffect(() => {
    if (travelAlertsMode === "off") return;
    if (!("geolocation" in navigator)) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };

        if (lastTravelPosition) {
          const bearing = getBearing(lastTravelPosition, nextPos);
          setTravelBearing(bearing);
        }

        setLastTravelPosition(nextPos);
        handleTravelLocationUpdate(nextPos);
      },
      (err) => {
        console.warn("Travel tracking error", err);
      },
      {
        enableHighAccuracy: false,
        maximumAge: 300000,
        timeout: 20000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [travelAlertsMode, location?.lat, location?.lon, handleTravelLocationUpdate, lastTravelPosition]);

  const sortedAlerts = useMemo(() => sortAlerts(alertsResp?.alerts || []), [alertsResp]);

  function isAhead(bearingToCounty: number, travelBearing: number) {
    const diff = Math.abs(((bearingToCounty - travelBearing + 540) % 360) - 180);
    return diff < 75;
  }

  function getDirectionLabel(bearing: number) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(bearing / 45) % 8];
  }

  const isRelevantAhead = useCallback(
    (countyFips: string, userPos: { lat: number; lon: number }, bearing: number) => {
      const center = countyCenters[countyFips];
      if (!center) return false;

      const distance = getDistanceMiles(userPos, center);
      if (distance > 150) return false; // keep reasonable range for squall lines

      const countyBearing = getBearing(userPos, center);
      if (!isAhead(countyBearing, bearing)) return false;

      const etaMinutes = (distance / STORM_SPEED_MPH) * 60;
      return etaMinutes <= 120; // only near-future alerts
    },
    [countyCenters]
  );

  const userPos = useMemo(() => {
    if (!location?.lat || !location?.lon) return null;
    return lastTravelPosition || { lat: location.lat, lon: location.lon };
  }, [location?.lat, location?.lon, lastTravelPosition]);

  const getEtaText = useCallback(
    (alert: AlertItem) => {
      if (!userPos || !alert.countyFips) return null;
      const center = countyCenters[alert.countyFips];
      if (!center) return null;

      const countyBearing = getBearing(userPos, center);
      if (travelBearing !== null && !isAhead(countyBearing, travelBearing)) {
        return null;
      }

      const distance = getDistanceMiles(userPos, center);
      const etaMinutes = (distance / STORM_SPEED_MPH) * 60;
      const etaLabel =
        etaMinutes < 30
          ? "Arriving soon"
          : etaMinutes < 60
          ? "Within 1 hour"
          : "Later";

      return `${etaLabel} • ${Math.round(distance)} mi ahead`;
    },
    [countyCenters, userPos, travelBearing]
  );

  function getDynamicHeroCTA(alert: AlertItem, etaText?: string | null) {
    if (etaText?.includes("Arriving")) {
      return "Take Action Now";
    }

    if (alert.severity === "Extreme" || alert.severity === "Severe") {
      return "Stay Alert";
    }

    return "View Details";
  }

  const filteredAlerts = useMemo(() => {
    if (!location) return sortedAlerts;

    if (travelAlertsMode === "follow") {
      if (location.countyFips) {
        const matched = sortedAlerts.filter((item) =>
          item.countyFips
            ? item.countyFips === location.countyFips
            : item.stateCode === location.stateCode
        );
        if (matched.length > 0) return matched;
      } else if (location.stateCode) {
        const inState = sortedAlerts.filter((item) => item.stateCode === location.stateCode);
        if (inState.length > 0) return inState;
      }
    }

    if (travelAlertsMode === "corridor") {
      if (travelBearing === null || !userPos) {
        return sortedAlerts.slice(0, 3);
      }

      return sortedAlerts.filter((item) => {
        if (!item.countyFips) return false;
        if (!countyCenters[item.countyFips]) return false;

        return isRelevantAhead(item.countyFips, userPos, travelBearing);
      });
    }

    if (location.stateCode) {
      const inState = sortedAlerts.filter((item) => item.stateCode === location.stateCode);
      if (inState.length > 0) return inState;
    }

    return sortedAlerts;
  }, [location, sortedAlerts, travelAlertsMode, travelBearing, userPos, countyCenters, isRelevantAhead]);

  const alertState: AlertState = filteredAlerts.length > 0 ? "ACTIVE_ALERTS" : "NO_ALERTS";
  const heroAlert =
    filteredAlerts.find((a) => getAlertPriority(a.event) >= 2) ||
    filteredAlerts[0] ||
    null;
  const locationLabel = location?.label || "Your Area";
  const activeLocationLabel =
    travelAlertsMode === "follow"
      ? `Following location • ${locationLabel}`
      : travelAlertsMode === "corridor"
      ? `Travel alerts active • ${locationLabel}`
      : locationLabel;

  const currentConditions: CurrentConditions = {
    temp: weather?.current?.temperatureF ?? fallbackCurrent.temp,
    feelsLike: weather?.current?.feelsLikeF ?? fallbackCurrent.feelsLike,
    condition: weather?.current?.condition || fallbackCurrent.condition,
    wind: weather?.current?.wind || fallbackCurrent.wind,
    humidity: weather?.current?.humidity ?? fallbackCurrent.humidity,
    uv: weather?.current?.uv || fallbackCurrent.uv,
    icon: resolveWeatherIcon(
      weather?.current?.condition || fallbackCurrent.condition,
      weather?.current?.isNight ?? fallbackCurrent.isNight,
    ),
    sunrise: weather?.current?.sunrise ?? fallbackCurrent.sunrise,
    sunset: weather?.current?.sunset ?? fallbackCurrent.sunset,
    isNight: weather?.current?.isNight ?? fallbackCurrent.isNight,
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

        if (!homeLocation) {
          setHomeLocation(saved);
          localStorage.setItem(HOME_LOCATION_KEY, JSON.stringify(saved));
        }

        setPromptDefaultToZip(false);
        setShowLocationPrompt(false);
        openNotificationPromptIfNeeded(saved);
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

  function openNotificationPromptIfNeeded(nextLocation: SavedLocation) {
    if (pushEnabled) return;
    if (notificationPromptSeen) return;
    if (!nextLocation.stateCode) return;

    setShowNotificationPrompt(true);
  }

  async function handleUseZip(zip: string) {
    try {
      const res = await fetch(`${API_BASE}/api/location?zip=${encodeURIComponent(zip)}`, {
        cache: "no-store",
      });
      const data = await safeJson(res);

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
        county: data.county || undefined,
        countyFips: data.countyFips || undefined,
        adjacentCountyFips: Array.isArray(data.adjacentCountyFips) ? data.adjacentCountyFips : undefined,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setLocation(saved);
      if (data.countyCenters && typeof data.countyCenters === "object") {
        setCountyCenters((prev) => ({
          ...prev,
          ...data.countyCenters,
        }));
      }
      if (data.countyFips && data.countyCenter && data.countyCenter.lat && data.countyCenter.lon) {
        setCountyCenters((prev) => ({
          ...prev,
          [data.countyFips]: {
            lat: data.countyCenter.lat,
            lon: data.countyCenter.lon,
          },
        }));
      }
      if (!homeLocation) {
        setHomeLocation(saved);
        localStorage.setItem(HOME_LOCATION_KEY, JSON.stringify(saved));
      }
      setShowLocationPrompt(false);
      openNotificationPromptIfNeeded(saved);
    } catch (err) {
      alert(err instanceof Error ? err.message : "ZIP lookup failed.");
    }
  }

  function markNotificationPromptSeen() {
    localStorage.setItem(NOTIFICATION_PROMPT_SEEN_KEY, "true");
    setNotificationPromptSeen(true);
  }

  function getDistanceMiles(from: { lat: number; lon: number }, to: { lat: number; lon: number }) {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const R = 3958.8; // miles
    const dLat = toRad(to.lat - from.lat);
    const dLon = toRad(to.lon - from.lon);
    const lat1 = toRad(from.lat);
    const lat2 = toRad(to.lat);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function getBearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }) {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const toDeg = (value: number) => (value * 180) / Math.PI;
    const fromLat = toRad(from.lat);
    const toLat = toRad(to.lat);
    const dLon = toRad(to.lon - from.lon);

    const y = Math.sin(dLon) * Math.cos(toLat);
    const x =
      Math.cos(fromLat) * Math.sin(toLat) -
      Math.sin(fromLat) * Math.cos(toLat) * Math.cos(dLon);

    const bearing = toDeg(Math.atan2(y, x));
    return (bearing + 360) % 360;
  }

  async function handleEnableNotificationsFromPrompt() {
    if (!location?.stateCode) return;

    const prefs =
      pushPrefs && pushPrefs.stateCode === location.stateCode
        ? pushPrefs
        : buildDefaultPushPreferences(location.stateCode);

    setPushBusy(true);
    try {
      await subscribeToPush(prefs);
      setPushEnabled(true);
      setPushPrefs(prefs);
      markNotificationPromptSeen();
      setShowNotificationPrompt(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to enable alerts");
    } finally {
      setPushBusy(false);
    }
  }

  function handleNotificationPromptDismiss() {
    markNotificationPromptSeen();
    setShowNotificationPrompt(false);
  }

  function setTravelMode(mode: "off" | "follow" | "corridor") {
    setTravelAlertsMode(mode);
    localStorage.setItem(TRAVEL_ALERTS_MODE_KEY, mode);
  }

  async function handleEnableNotifications() {
    if (!location?.stateCode) {
      alert("Set your location first.");
      return;
    }

    const prefs =
      pushPrefs && pushPrefs.stateCode === location.stateCode
        ? pushPrefs
        : buildDefaultPushPreferences(location.stateCode);

    setPushBusy(true);
    try {
      await subscribeToPush(prefs);
      setPushEnabled(true);
      setPushPrefs(prefs);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to enable alerts");
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisableNotifications() {
    setPushBusy(true);
    try {
      await unsubscribeFromPush();
      setPushEnabled(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to disable alerts");
    } finally {
      setPushBusy(false);
    }
  }

  async function handleSavePushPreferences(next: PushPreferences) {
    setPushPrefs(next);

    if (!pushEnabled) return;

    setPushBusy(true);
    try {
      await updatePushPreferences(next);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setPushBusy(false);
    }
  }

  function renderHomeTab() {
    const tone = getRiskTone(filteredAlerts);
    const dynamicCta = getDynamicCta(tone);

    const hourlyPoints: HourlyPoint[] = weather?.hourly?.length
      ? weather.hourly.map((p) => {
          const isNightHour = isNightForHour(
            p.startTime,
            weather?.current?.sunrise,
            weather?.current?.sunset
          );

          return {
            label: new Date(p.startTime || Date.now()).toLocaleTimeString([], {
              hour: "numeric",
            }),
            temp: p.temperatureF ?? p.temp ?? 0,
            icon: resolveWeatherIcon(p.shortForecast, isNightHour),
            precip: p.precipitationChance ?? p.precip ?? 0,
            startTime: p.startTime,
            shortForecast: p.shortForecast,
          };
        })
      : fallbackHourly;

    const systemStatus =
      alertState === "ACTIVE_ALERTS"
        ? tone === "warning"
          ? "Severe Weather Active"
          : tone === "watch"
          ? "Monitoring Conditions"
          : "All Clear"
        : "All Clear";

    const systemStatusPill =
      tone === "warning"
        ? "bg-red-500"
        : tone === "watch"
        ? "bg-amber-400"
        : "bg-emerald-400";

    const otherAlerts = heroAlert ? filteredAlerts.filter((a) => a !== heroAlert) : [];
    const actionLines = buildWhatToWatch({
      alerts: filteredAlerts,
      current: currentConditions,
      hourly: hourlyPoints,
      locationLabel,
    });

    return (
      <div className={cn("space-y-4", alertState === "NO_ALERTS" && "space-y-3")}>
        <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-3">
          <div className="flex items-center gap-2 text-sm font-black uppercase text-white">
            <span className={cn("h-2 w-2 rounded-full", systemStatusPill)} />
            {systemStatus}
          </div>
          <div className="text-xs text-slate-300">Updated {formatLiveStatusTime(lastCheckedAt)}</div>
          {travelAlertsMode !== 'off' ? (
            <>
              <div className="mt-1 text-xs text-slate-400">Updated based on your movement</div>
              <div className="mt-1 text-xs text-slate-400">
                {travelLocationUpdatedAt
                  ? `Last location refresh: ${formatLiveStatusTime(travelLocationUpdatedAt)}`
                  : "Location updates will appear here."}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {travelBearing !== null ? `Heading ${getDirectionLabel(travelBearing)}` : ""}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {travelAlertsMode === 'follow'
                  ? 'Travel alerts active (following your location).'
                  : 'Travel corridor mode active (includes next counties).'}
              </div>
              <div className="mt-1 text-xs font-bold">
                {travelLocationUpdatedAt
                  ? `Updated ${formatLiveStatusTime(travelLocationUpdatedAt)}`
                  : 'Waiting for location…'}
              </div>
            </>
          ) : null}
        </div>

        {alertState === "ACTIVE_ALERTS" && heroAlert ? (
          <>
            {(() => {
              const heroEta = getEtaText(heroAlert);
              return (
                <BigAlertHero
                  alert={heroAlert}
                  etaText={heroEta}
                  ctaText={getDynamicHeroCTA(heroAlert, heroEta)}
                  onPrimaryAction={(alert) => openExternal(alert.nwsUrl)}
                  onViewDetails={(alert) => setSelectedAlert(alert)}
                />
              );
            })()}

            {!pushEnabled && tone === "warning" ? (
              <Card className="rounded-[24px] border border-yellow-400/20 bg-yellow-500/10 text-yellow-100 shadow-sm">
                <CardContent className="p-4">
                  <div className="text-sm font-black uppercase tracking-wide">Alerts are off</div>
                  <div className="mt-2 text-sm text-yellow-100">
                    Severe conditions are active for your area. Enable alerts anytime in More.
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="p-5">
                <div className="text-xl font-black uppercase tracking-wide">What You Should Do</div>
                <div className="mt-4 space-y-3 text-sm leading-6">
                  {actionLines.map((line, i) => (
                    <div key={i} className={cn("flex gap-2", i === 0 ? "font-semibold text-white" : "text-sky-100")}> 
                      <span>•</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {otherAlerts.length > 0 && (
              <GroupedAlertsList
                alerts={otherAlerts}
                onSelectAlert={(alert) => setSelectedAlert(alert)}
                getEtaText={getEtaText}
              />
            )}
          </>
        ) : (
          <>
            <AllClearBanner
            locationLabel={activeLocationLabel}
            lastPoll={lastCheckedAt}
            backgroundImage={resolveWeatherBackground(
              currentConditions.condition,
              currentConditions.isNight
            )}
          />

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="p-5">
                <div className="text-xl font-black uppercase tracking-wide">What You Should Do</div>
                <div className="mt-4 space-y-3 text-sm leading-6">
                  {actionLines.map((line, i) => (
                    <div key={i} className={cn("flex gap-2", i === 0 ? "font-semibold text-white" : "text-sky-100")}> 
                      <span>•</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[24px] border border-white/10 bg-slate-950/70 text-white shadow-xl">
              <CardContent className="p-4">
                <div className="text-sm font-black uppercase tracking-wide">Stay notified</div>
                <div className="mt-2 text-sm text-slate-300">
                  No alerts right now — get notified instantly if that changes.
                </div>
                <div className="text-xs text-slate-400 mt-1 text-center">
                  Instant alerts • No spam
                </div>
                {!pushEnabled ? (
                  <>
                    <Button
                      onClick={handleEnableNotifications}
                      disabled={pushBusy}
                      className="mt-4 h-11 w-full rounded-2xl bg-blue-600 font-bold hover:bg-blue-500"
                    >
                      {pushBusy ? "Enabling..." : dynamicCta.button}
                    </Button>
                    <div className="text-xs text-sky-200 mt-2 text-center">{dynamicCta.subtext}</div>
                  </>
                ) : (
                  <Button
                    onClick={() => setActiveTab("more")}
                    variant="secondary"
                    className="mt-4 h-11 w-full rounded-2xl font-bold"
                  >
                    Manage Alert Settings
                  </Button>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <div id="radar-section">
          <RadarPreviewCard
            radar={weather?.radar || null}
            location={{
              lat: weather?.location?.lat ?? location?.lat ?? 37.1671,
              lon: weather?.location?.lon ?? location?.lon ?? -83.2913,
              label: weather?.location?.label || locationLabel,
            }}
            onViewRadar={() => setShowRadarModal(true)}
            modalOpen={showRadarModal}
          />
          {alertState === "ACTIVE_ALERTS" && filteredAlerts.length > 0 ? (
            <div className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-100">
              Storms approaching — radar is focused on the alert area.
            </div>
          ) : null}
        </div>

        <CurrentConditionsCard
          current={currentConditions}
          locationLabel={activeLocationLabel}
          heroMode
        />

        <div id="forecast-section">
          <HourlyStrip
            points={hourlyPoints}
            onView10Day={() => setActiveTab("forecast")}
          />
        </div>
      </div>
    );
  }

  function renderForecastTab() {
    const forecastDays = (weather?.daily || []).slice(0, 10) as DailyForecast[];

    const warmest = forecastDays.reduce((best: DailyForecast | null, day: DailyForecast) => {
      const hi = day?.highF ?? day?.temperatureF ?? day?.temperature ?? 0;
      const bestHi = best ? best.highF ?? best.temperatureF ?? best.temperature ?? 0 : 0;
      return hi > bestHi ? day : best;
    }, null);

    const stormiest = forecastDays.reduce((best: DailyForecast | null, day: DailyForecast) => {
      const precip = day?.precipitationChance ?? day?.pop ?? 0;
      const bestPrecip = best ? best.precipitationChance ?? best.pop ?? 0 : 0;
      return precip > bestPrecip ? day : best;
    }, null);

    const bestDay = forecastDays.reduce((best: (DailyForecast & { _score?: number }) | null, day: DailyForecast) => {
      const precip = day?.precipitationChance ?? day?.pop ?? 0;
      const hi = day?.highF ?? day?.temperatureF ?? day?.temperature ?? 0;
      const score = (hi ?? 0) - precip;
      if (!best) return { ...day, _score: score };
      return score > (best._score ?? -Infinity) ? { ...day, _score: score } : best;
    }, null);

    return (
      <div className="space-y-4">
        <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-xl font-black uppercase tracking-wide">10-Day Forecast</div>
              <div className="text-sm text-slate-400">{locationLabel}</div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              {warmest ? (
                <div className="rounded-xl bg-yellow-500/10 px-3 py-1 font-semibold text-yellow-200">
                  Warmest: {warmest?.name || "Day"}
                </div>
              ) : null}
              {stormiest ? (
                <div className="rounded-xl bg-red-500/10 px-3 py-1 font-semibold text-red-200">
                  Stormiest: {stormiest?.name || "Day"}
                </div>
              ) : null}
              {bestDay ? (
                <div className="rounded-xl bg-sky-500/10 px-3 py-1 font-semibold text-sky-200">
                  Best: {bestDay?.name || "Day"}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {forecastDays.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-slate-300">
              Forecast data is unavailable right now.
            </div>
          ) : (
            forecastDays.map((day: DailyForecast, idx: number) => {
              const name = day?.name || `Day ${idx + 1}`;
              const text = day?.shortForecast || day?.detailedForecast || "Forecast unavailable";
              const high = day?.highF ?? day?.temperatureF ?? day?.temperature ?? null;
              const low = day?.lowF ?? day?.nightTemperature ?? day?.nightTemp ?? null;
              const precip = day?.precipitationChance ?? day?.pop ?? 0;
              const wind = day?.wind || day?.windSpeed || "—";

              return (
                <div
                  key={`${name}-${idx}`}
                  className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-base font-black text-white">{name}</div>
                      <div className="mt-1 text-sm text-slate-300">{text}</div>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                        <span>Rain {precip}%</span>
                        <span>Wind {wind}</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-2xl font-black text-white">{high ?? "—"}°</div>
                      <div className="text-sm text-slate-400">Low {low ?? "—"}°</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  function renderRadarTab() {
    return (
      <div className="space-y-5">
        <Card className="overflow-hidden rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase tracking-wide">
              <Radar className="h-5 w-5 text-red-400" />
              Live Radar
            </div>

            <button
              type="button"
              onClick={() => setShowRadarModal(true)}
              className="flex w-full items-center justify-between rounded-[22px] border border-white/10 bg-white/5 px-4 py-4 text-left transition hover:border-sky-400/40 hover:bg-white/10 active:scale-[0.99]"
            >
              <div>
                <div className="text-lg font-black text-white">Open Full Radar</div>
                <div className="mt-1 text-sm text-slate-300">
                  Interactive map with radar loop for {location?.label || "your area"}
                </div>
              </div>

              <div className="rounded-full bg-blue-600 px-4 py-2 text-sm font-bold text-white">
                Open
              </div>
            </button>
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="text-xl font-black uppercase tracking-wide">Radar Details</div>
            <div className="mt-4 space-y-2 text-base text-slate-200">
              <div>{weather?.radar?.summary || "Live radar available"}</div>
              <div className="text-sm text-slate-400">
                {formatLiveTime(weather?.radar?.updated)}
              </div>
              {weather?.radar?.station ? (
                <div className="text-sm text-slate-400">Station: {weather.radar.station}</div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

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

  function getSeverityBucket(severity?: string) {
    const value = String(severity || "").toLowerCase();

    if (value === "extreme") return "Extreme";
    if (value === "severe") return "Severe";
    if (value === "moderate") return "Moderate";
    if (value === "minor") return "Minor";
    return "Other";
  }

  function getSeverityStyles(severity?: string) {
    const value = String(severity || "").toLowerCase();

    if (value === "extreme") {
      return {
        sectionBadge: "bg-red-600 text-white border-red-300/30",
        card: "from-red-800 to-red-700 border-red-400/30",
        pill: "bg-red-950 text-white border-red-300/30",
      };
    }

    if (value === "severe") {
      return {
        sectionBadge: "bg-red-500/15 text-red-200 border-red-400/20",
        card: "from-red-700 to-red-600 border-red-500/20",
        pill: "bg-red-950/60 text-red-100 border-red-300/20",
      };
    }

    if (value === "moderate") {
      return {
        sectionBadge: "bg-amber-500/15 text-amber-200 border-amber-400/20",
        card: "from-amber-600 to-orange-600 border-amber-400/20",
        pill: "bg-amber-950/50 text-amber-100 border-amber-300/20",
      };
    }

    if (value === "minor") {
      return {
        sectionBadge: "bg-yellow-500/15 text-yellow-100 border-yellow-400/20",
        card: "from-yellow-600 to-yellow-500 border-yellow-300/20",
        pill: "bg-yellow-950/50 text-yellow-50 border-yellow-200/20",
      };
    }

    return {
      sectionBadge: "bg-slate-700/40 text-slate-200 border-white/10",
      card: "from-slate-700 to-slate-600 border-white/10",
      pill: "bg-slate-900/50 text-slate-100 border-white/10",
    };
  }

  function getAlertTypeMeta(event?: string) {
    const text = String(event || "").toLowerCase();

    if (text.includes("fog")) {
      return {
        label: "Fog",
        icon: CloudFog,
      };
    }

    if (
      text.includes("flood") ||
      text.includes("high surf") ||
      text.includes("coastal")
    ) {
      return {
        label: "Flood",
        icon: Waves,
      };
    }

    if (
      text.includes("storm") ||
      text.includes("thunderstorm") ||
      text.includes("tornado") ||
      text.includes("rain")
    ) {
      return {
        label: "Storm",
        icon: CloudRain,
      };
    }

    return {
      label: "Alert",
      icon: TriangleAlert,
    };
  }

  function buildWhatToWatch({
    alerts,
    current,
    hourly,
    locationLabel,
  }: {
    alerts: AlertItem[];
    current: CurrentConditions;
    hourly: HourlyPoint[];
    locationLabel: string;
  }) {
    const lines: string[] = [];
    const tone = getRiskTone(alerts);
    const condition = current.condition.toLowerCase();

    // 1. Primary status line
    if (tone === "calm") {
      lines.push(`No active alerts near ${locationLabel}`);
    } else if (tone === "watch") {
      lines.push(`${alerts[0].event} in effect for your area`);
    } else {
      lines.push(`${alerts[0].event} — stay alert and ready to act`);
    }

    // 2. Current pattern line
    if (tone === "warning") {
      if (condition.includes("storm") || condition.includes("thunder")) {
        lines.push("Hazardous weather is possible nearby");
      } else if (condition.includes("fog")) {
        lines.push("Visibility may change quickly in spots");
      } else {
        lines.push("Conditions can worsen quickly in your area");
      }
    } else if (tone === "watch") {
      if (condition.includes("storm") || condition.includes("thunder")) {
        lines.push("Storm chances are increasing today");
      } else if (condition.includes("rain")) {
        lines.push("Unsettled weather remains possible");
      } else {
        lines.push("Stay weather-aware through the day");
      }
    } else {
      if (condition.includes("fog")) {
        lines.push("Visibility may drop below 1 mile at times");
      } else if (condition.includes("storm") || condition.includes("thunder")) {
        lines.push("Storms possible — monitor conditions closely");
      } else if (condition.includes("rain")) {
        lines.push("Light rain possible in your area");
      } else {
        lines.push("Stable weather pattern in place");
      }
    }

    // 3. Next-change line
    const nextStorm = hourly.find(
      (h) => (h.precip ?? 0) >= 40 || h.icon === "storm"
    );

    if (nextStorm) {
      if (tone === "warning") {
        lines.push(`Storm activity may increase around ${nextStorm.label}`);
      } else if (tone === "watch") {
        lines.push(`Storm chances increase around ${nextStorm.label}`);
      } else {
        lines.push(`Rain chances increase around ${nextStorm.label}`);
      }
    } else {
      const nextChange = hourly.find((h, i) => {
        if (i === 0) return false;
        return (
          h.shortForecast !== hourly[0]?.shortForecast ||
          h.icon !== hourly[0]?.icon
        );
      });

      if (nextChange) {
        const label =
          nextChange.label ||
          (nextChange.startTime
            ? new Date(nextChange.startTime).toLocaleTimeString([], {
                hour: "numeric",
              })
            : null);

        const nextText = String(nextChange.shortForecast || "").toLowerCase();

        if (nextText.includes("cloud")) {
          lines.push(`Clouds increase around ${label}`);
        } else if (nextText.includes("sun") || nextText.includes("clear")) {
          lines.push(`Clearing skies around ${label}`);
        } else if (nextText.includes("rain") || nextText.includes("shower")) {
          lines.push(`Rain chances begin around ${label}`);
        } else if (nextText.includes("fog")) {
          lines.push(`Fog develops around ${label}`);
        } else if (label) {
          lines.push(`Conditions change around ${label}`);
        } else {
          lines.push("Conditions change later today");
        }
      } else {
        lines.push(
          tone === "warning"
            ? "Hazards may persist through the next few hours"
            : "Conditions remain steady through the next few hours"
        );
      }
    }

    // 4. Guidance line
    const hour = new Date().getHours();

    if (tone === "warning") {
      lines.push("Be ready to take shelter if warnings are issued");
    } else if (tone === "watch") {
      if (hour >= 18) {
        lines.push("Keep alerts enabled through the evening");
      } else {
        lines.push("Check radar again before heading out");
      }
    } else if (hour >= 18) {
      lines.push("Quiet conditions continue overnight");
    } else if (hour <= 9) {
      if (condition.includes("cloud")) {
        lines.push("Cloud cover decreases through the morning");
      } else if (condition.includes("fog")) {
        lines.push("Fog clearing through the morning");
      } else if (condition.includes("rain")) {
        lines.push("Rain tapers off through the morning");
      } else {
        lines.push("Quiet conditions continue through the morning");
      }
    }

    return lines.slice(0, 4);
  }

  function groupAlertsBySeverity(alerts: AlertItem[]) {
    const groups: Record<string, AlertItem[]> = {
      Extreme: [],
      Severe: [],
      Moderate: [],
      Minor: [],
      Other: [],
    };

    alerts.forEach((alert) => {
      groups[getSeverityBucket(alert.severity)].push(alert);
    });

    return [
      { key: "Extreme", items: groups.Extreme },
      { key: "Severe", items: groups.Severe },
      { key: "Moderate", items: groups.Moderate },
      { key: "Minor", items: groups.Minor },
      { key: "Other", items: groups.Other },
    ].filter((group) => group.items.length > 0);
  }

  function formatTimeLeft(expires?: string) {
    if (!expires) return "";
    const end = new Date(expires).getTime();
    if (Number.isNaN(end)) return "";
    const now = Date.now();
    const diff = end - now;
    if (diff <= 0) return "Now";

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h left`;
    if (hours > 0) return `${hours}h ${minutes % 60}m left`;
    return `${minutes}m left`;
  }

  function renderAlertsTab() {
    const groupedAlerts = groupAlertsBySeverity(filteredAlerts);

    return (
      <div className="space-y-4">
        {filteredAlerts.length > 0 ? (
          <>
            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xl font-black uppercase tracking-wide">
                      Active Alerts
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-black text-emerald-200">
                        <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                        Live
                      </span>
                    </div>
                    <div className="mt-2 text-sm text-slate-300">
                      {filteredAlerts.length} active {filteredAlerts.length === 1 ? "alert" : "alerts"} for {locationLabel}
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      Last checked {formatLiveStatusTime(lastCheckedAt)}
                    </div>
                    {(newAlertCount > 0 || updatedAlertCount > 0) ? (
                      <div className="mt-2 text-xs font-bold text-sky-200">
                        {newAlertCount > 0 ? `${newAlertCount} new` : ""}
                        {newAlertCount > 0 && updatedAlertCount > 0 ? " • " : ""}
                        {updatedAlertCount > 0 ? `${updatedAlertCount} updated` : ""}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-full border border-red-400/20 bg-red-500/15 px-3 py-1 text-sm font-black text-red-100">
                    {filteredAlerts.length}
                  </div>
                </div>
              </CardContent>
            </Card>

            {groupedAlerts.map((group, groupIndex) => {
              const styles = getSeverityStyles(group.key);

              return (
                <div
                  key={group.key}
                  className={groupIndex === 0 ? "space-y-3" : "mt-6 border-t border-white/10 pt-4"}
                >
                  <div className="flex items-center justify-between px-1">
                    <div className="text-sm font-black uppercase tracking-[0.18em] text-slate-300">
                      {group.key}
                    </div>
                    <div
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-black",
                        styles.sectionBadge
                      )}
                    >
                      {group.items.length}
                    </div>
                  </div>

                  {group.items
                    .slice()
                    .sort((a, b) => new Date(a.expires).getTime() - new Date(b.expires).getTime())
                    .map((alert) => {
                      const typeMeta = getAlertTypeMeta(alert.event);
                      const Icon = typeMeta.icon;
                      const cardStyles = getSeverityStyles(alert.severity);
                      const liveMeta = alertLiveMap[alert.id];

                      return (
                        <button
                          key={alert.id}
                          type="button"
                          onClick={() => setSelectedAlert(alert)}
                          className={cn(
                            "relative overflow-hidden w-full rounded-[22px] border px-4 py-4 text-left text-white shadow-lg transition-transform hover:scale-[1.01] active:scale-[0.98]",
                            cardStyles.card
                          )}
                          style={{
                            backgroundImage: getHeroVariantBackgroundImageIfExists(alert.event)
                              ? `url(${getHeroVariantBackgroundImageIfExists(alert.event)})`
                              : undefined,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                          }}
                        >
                          <div className="absolute inset-0" style={{ background: getAlertBackground(alert.event), opacity: 0.75 }} />
                          <div className="relative z-10 flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-wide",
                                  cardStyles.pill
                                )}
                              >
                                <Icon className="h-3.5 w-3.5" />
                                {typeMeta.label}
                              </div>

                              <div className="text-[11px] font-black uppercase tracking-wide text-white/90">
                                {alert.event}
                              </div>

                              {liveMeta?.changeType === "new" ? (
                                <div className="rounded-full border border-emerald-300/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-100 animate-pulse">
                                  New
                                </div>
                              ) : null}

                              {liveMeta?.changeType === "updated" ? (
                                <div className="rounded-full border border-sky-300/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-sky-100">
                                  Updated
                                </div>
                              ) : null}
                            </div>

                            <div className="mt-3 text-xl font-black leading-tight">
                              {heroAreaLabel(alert)}
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-white/90">
                              <div>
                                <span className="font-black text-white">Issued:</span>{" "}
                                {formatIssuedTime(alert.sent || alert.effective)}
                              </div>
                              <div>
                                <span className="font-black text-white">Until:</span>{" "}
                                {formatTime(alert.expires)}
                              </div>
                            </div>

                            {alert.headline ? (
                              <div className="mt-3 line-clamp-2 text-sm text-white/90 font-medium">
                                {alert.headline}
                              </div>
                            ) : null}
                            <div className="mt-1 text-xs text-white/70">
                              {formatTimeLeft(alert.expires)}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </>
        ) : (
          <Card className="rounded-[30px] border border-sky-300/15 bg-gradient-to-br from-sky-900/80 to-blue-950 text-white shadow-xl">
            <CardContent className="p-5">
              <div className="text-xl font-black uppercase tracking-wide">All Clear</div>
              <div className="mt-3 text-sm text-sky-100">
                No active weather alerts for your area.
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  function renderMoreTab() {
    const prefs =
      pushPrefs ||
      (location?.stateCode ? buildDefaultPushPreferences(location.stateCode) : null);

    return (
      <div className="space-y-4">

        {/* HEADER */}
        <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="text-xl font-black uppercase tracking-wide">
              Alerts & Notifications
            </div>
            <div className="mt-2 text-sm text-slate-400">
              Manage weather alerts for your area
            </div>
          </CardContent>
        </Card>

        {/* STATUS CARD */}
        <Card className="rounded-[30px] border border-blue-500/20 bg-gradient-to-br from-blue-600 to-blue-800 text-white shadow-xl">
          <CardContent className="p-5">
            <div className="text-lg font-black">
              {pushEnabled ? 'Notifications Enabled' : 'Weather Alerts Are Off'}
            </div>
            <div className="mt-2 text-sm text-blue-100">
              {pushEnabled
                ? 'You’ll receive weather alerts for your selected area.'
                : 'Turn on notifications to get important weather alerts faster.'}
            </div>
            <div className="mt-4 text-sm text-blue-50">
              Current area: {location?.label || 'Not set'}
            </div>

            {pushEnabled ? (
              <Button
                onClick={handleDisableNotifications}
                disabled={pushBusy}
                className="mt-4 h-11 w-full rounded-2xl bg-white font-bold text-blue-700 hover:bg-blue-100"
              >
                {pushBusy ? 'Disabling...' : 'Disable Notifications'}
              </Button>
            ) : (
              <Button
                onClick={handleEnableNotifications}
                disabled={pushBusy}
                className="mt-4 h-11 w-full rounded-2xl bg-white font-bold text-blue-700 hover:bg-blue-100"
              >
                {pushBusy ? 'Enabling...' : 'Enable Notifications'}
              </Button>
            )}
          </CardContent>
        </Card>

        {prefs ? (
          <>
            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="space-y-4 p-5">
                <div className="text-lg font-black">Alert Types</div>

                {([
                  ['warnings', 'Warnings'],
                  ['watches', 'Watches'],
                  ['advisories', 'Advisories'],
                  ['statements', 'Statement Updates'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={prefs.alertTypes[key]}
                      onChange={(e) =>
                        handleSavePushPreferences({
                          ...prefs,
                          alertTypes: {
                            ...prefs.alertTypes,
                            [key]: e.target.checked,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </CardContent>
            </Card>

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="space-y-4 p-5">
                <div className="text-lg font-black">Delivery Scope</div>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={prefs.deliveryScope === 'state' ? 'default' : 'secondary'}
                    onClick={() =>
                      handleSavePushPreferences({
                        ...prefs,
                        deliveryScope: 'state',
                      })
                    }
                    className="h-11 rounded-2xl"
                  >
                    Statewide
                  </Button>
                  <Button
                    variant={prefs.deliveryScope === 'county' ? 'default' : 'secondary'}
                    onClick={() =>
                      handleSavePushPreferences({
                        ...prefs,
                        deliveryScope: 'county',
                      })
                    }
                    className="h-11 rounded-2xl"
                  >
                    County
                  </Button>
                </div>

                <div className="text-xs text-slate-400">
                  County mode is wired in the preference model now. Full county-targeted
                  delivery needs county data added to your location API.
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="space-y-4 p-5">
                <div className="text-lg font-black">Travel Alerts</div>

                <div className="grid grid-cols-1 gap-2">
                  <Button
                    variant={travelAlertsMode === 'off' ? 'default' : 'secondary'}
                    onClick={() => setTravelMode('off')}
                    className="h-11 rounded-2xl"
                  >
                    Off
                  </Button>
                  <Button
                    variant={travelAlertsMode === 'follow' ? 'default' : 'secondary'}
                    onClick={() => setTravelMode('follow')}
                    className="h-11 rounded-2xl"
                  >
                    Follow my location
                  </Button>
                  <Button
                    variant={travelAlertsMode === 'corridor' ? 'default' : 'secondary'}
                    onClick={() => setTravelMode('corridor')}
                    className="h-11 rounded-2xl"
                  >
                    Follow + ahead on route
                  </Button>
                </div>

                <div className="text-xs text-slate-400">
                  Updates alert coverage as you move. Best for road trips.
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="space-y-4 p-5">
                <div className="text-lg font-black">Quiet Hours</div>

                <label className="flex items-center justify-between text-sm">
                  <span>Enable Quiet Hours</span>
                  <input
                    type="checkbox"
                    checked={prefs.quietHours.enabled}
                    onChange={(e) =>
                      handleSavePushPreferences({
                        ...prefs,
                        quietHours: {
                          ...prefs.quietHours,
                          enabled: e.target.checked,
                        },
                      })
                    }
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <div className="mb-1 text-slate-400">Start</div>
                    <input
                      type="time"
                      value={prefs.quietHours.start}
                      onChange={(e) =>
                        handleSavePushPreferences({
                          ...prefs,
                          quietHours: {
                            ...prefs.quietHours,
                            start: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white"
                    />
                  </label>
                  <label className="text-sm">
                    <div className="mb-1 text-slate-400">End</div>
                    <input
                      type="time"
                      value={prefs.quietHours.end}
                      onChange={(e) =>
                        handleSavePushPreferences({
                          ...prefs,
                          quietHours: {
                            ...prefs.quietHours,
                            end: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white"
                    />
                  </label>
                </div>

                <div className="text-xs text-slate-400">
                  Tornado and severe warning-level alerts should still break through.
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
              <CardContent className="p-5">
                <div className="text-lg font-black">Location</div>
                <div className="mt-2 text-sm text-slate-400">{location?.label || 'Not set'}</div>

                <Button
                  onClick={() => setShowLocationPrompt(true)}
                  className="mt-4 h-11 w-full rounded-2xl"
                >
                  Change Location
                </Button>
              </CardContent>
            </Card>
          </>
        ) : null}
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
              <div className="text-xs text-slate-400">
                {loadingWeather
                  ? "Loading weather..."
                  : loadingAlerts
                  ? "Loading alerts..."
                  : "Live • Monitoring"}
              </div>
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
          {activeTab === "more" && renderMoreTab()}

          {alertsResp?.syncError ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {alertsResp.syncError}
            </div>
          ) : null}
          {weatherError ? (
            <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {weatherError}
            </div>
          ) : null}
        </div>
      </div>

      <BottomNav
        alertCount={filteredAlerts.length}
        activeTab={activeTab}
        onChangeTab={(tab) => {
          setActiveTab(tab);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      <RadarMapModal
        open={showRadarModal}
        onClose={() => setShowRadarModal(false)}
        location={
          weather?.location || {
            lat: 38.0406,
            lon: -84.5037,
            label: "Your Area",
          }
        }
        radar={weather?.radar || null}
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

      {showNotificationPrompt ? (
        <NotificationPrompt
          locationLabel={location?.label || "your area"}
          busy={pushBusy}
          onEnable={handleEnableNotificationsFromPrompt}
          onNotNow={handleNotificationPromptDismiss}
        />
      ) : null}
    </div>
  );
}
