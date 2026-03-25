"use client";
import React, { useEffect, useMemo, useState } from "react";
import { Bell, Map, Menu, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import RadarPreviewCard from "@/components/weather/RadarPreviewCard";
import CurrentConditionsCard from "@/components/weather/CurrentConditionsCard";
import HourlyStrip from "@/components/weather/HourlyStrip";
import AlertDetailsSheet from "@/components/alerts/AlertDetailsSheet";
import BottomNav from "@/components/navigation/BottomNav";
import LocationPrompt from "@/components/location/LocationPrompt";
import RadarMapModal from "@/components/RadarMapModal";
import BigAlertHero from "@/components/alerts/BigAlertHero";
import SmallAlertCard from "@/components/alerts/SmallAlertCard";
import SingleSecondaryAlertCard from "@/components/alerts/SingleSecondaryAlertCard";
import AlertHeadlineList from "@/components/alerts/AlertHeadlineList";
import { motion } from "framer-motion";

import { openExternal } from "@/lib/utils";
import { fetchWeather, safeJson } from "@/lib/api/client";
import { formatTime, formatRelative, mapIcon } from "@/lib/weather/formatters";
import { sortAlerts, getAlertPriority, heroAreaLabel } from "@/lib/alerts/helpers";

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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

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
  const [showRadarModal, setShowRadarModal] = useState(false);

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
        const data = (await safeJson(res)) as AlertsResponse & { error?: string };

        if (!res.ok) {
          throw new Error(data?.error || "Unable to load alerts.");
        }

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
            onViewRadar={() => setShowRadarModal(true)}
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
      <div className="space-y-4">
        <RadarPreviewCard
          alertState={alertState}
          radar={weather?.radar || null}
          onViewRadar={() => setShowRadarModal(true)}
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
              <div className="text-xs text-slate-400">
                {loadingWeather
                  ? "Loading weather..."
                  : loadingAlerts
                  ? "Loading alerts..."
                  : `Synced ${formatRelative(alertsResp?.lastPoll)}`}
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
          if (tab === "more") {
            setShowLocationPrompt(true);
            return;
          }

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
    </div>
  );
}
