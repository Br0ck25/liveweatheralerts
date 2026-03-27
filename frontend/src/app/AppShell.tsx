import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { getAlerts } from "../lib/api/alerts";
import { geocodeByQuery, geocodeByZip } from "../lib/api/geocode";
import { getWeather } from "../lib/api/weather";
import {
  PWA_OFFLINE_READY_EVENT,
  PWA_UPDATE_AVAILABLE_EVENT,
  applyPwaUpdate
} from "../lib/pwa/register";
import {
  isLikelyStateOnlyInput,
  isLocationModalDismissed,
  readSavedActiveTab,
  resolveStateFromText,
  saveActiveTab,
  setLocationModalDismissed,
  toStateCode,
  normalizeCountyCode
} from "../lib/storage/location";
import {
  PLACE_LABEL_PRESETS,
  createSavedPlaceFromResolvedLocation,
  removeSavedPlaceById,
  readSavedPlaces,
  setPrimarySavedPlace,
  upsertSavedPlace,
  writeSavedPlaces,
  type PlaceLabelPreset
} from "../lib/storage/places";
import type {
  AlertRecord,
  AlertTypeFilter,
  AlertsPayload,
  BeforeInstallPromptEvent,
  SavedPlace,
  SeverityFilter,
  SortMode,
  WeatherPayload
} from "../types";
import {
  canonicalAlertDetailPath,
  alertEffectiveEndMs,
  alertEffectiveStartMs,
  alertMatchesCounty,
  classifyAlertType,
  normalizeSeverity,
  parseTime,
  priorityScore
} from "../features/alerts/utils";
import { AlertsPage } from "../features/alerts/pages/AlertsPage";
import { AlertDetailPage } from "../features/alerts/pages/AlertDetailPage";
import { AlertHistoryPage } from "../features/alerts/pages/AlertHistoryPage";
import { ForecastPage } from "../features/forecast/pages/ForecastPage";
import { SettingsPage } from "../features/settings/pages/SettingsPage";
import { LocationModal } from "../features/locations/components/LocationModal";

type LoadState = "loading" | "ready" | "error";
type ForecastLoadState = "idle" | "loading" | "ready" | "error";
type NetworkRecoveryState = "idle" | "offline" | "reconnecting" | "reconnected";
type PendingReconnectTargets = {
  alerts: number;
  forecast: number;
  detail: number;
  history: number;
};

const FORECAST_ALERT_CARRYOVER_MS = 3 * 60 * 60 * 1000;

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function resolveStateFromZip(
  zip: string
): Promise<{
  stateCode: string;
  label: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
}> {
  const payload = await geocodeByZip(zip);
  const stateCode = toStateCode(payload.state ?? "");
  if (!stateCode) {
    throw new Error("ZIP code lookup did not return a valid state.");
  }

  const city = (payload.city ?? "").trim();
  const countyName = (payload.county ?? "").trim();
  const countyCode = normalizeCountyCode(payload.countyCode ?? "");
  const lat = toFiniteNumber(payload.lat);
  const lon = toFiniteNumber(payload.lon);
  return {
    stateCode,
    label: city ? `${city}, ${stateCode}` : stateCode,
    countyName: countyName || undefined,
    countyCode: countyCode || undefined,
    lat,
    lon
  };
}

async function resolveLocationFromQuery(
  query: string
): Promise<{
  stateCode: string;
  label: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
}> {
  const payload = await geocodeByQuery(query);

  const stateCode = toStateCode(payload.state ?? "");
  if (!stateCode) {
    throw new Error("Could not determine a valid state for that location.");
  }

  const countyName = (payload.county ?? "").trim();
  const countyCode = normalizeCountyCode(payload.countyCode ?? "");
  const label = (payload.label ?? "").trim() || `${query}, ${stateCode}`;
  const lat = toFiniteNumber(payload.lat);
  const lon = toFiniteNumber(payload.lon);

  return {
    stateCode,
    label,
    countyName: countyName || undefined,
    countyCode: countyCode || undefined,
    lat,
    lon
  };
}

async function resolveForecastCoordinates(
  place: SavedPlace | null
): Promise<{ lat: number; lon: number } | null> {
  if (
    place &&
    typeof place.lat === "number" &&
    Number.isFinite(place.lat) &&
    typeof place.lon === "number" &&
    Number.isFinite(place.lon)
  ) {
    return { lat: place.lat, lon: place.lon };
  }

  if (!place?.rawInput.trim()) {
    return null;
  }

  const rawInput = place.rawInput.trim();
  try {
    if (/^\d{5}$/.test(rawInput)) {
      const resolved = await resolveStateFromZip(rawInput);
      if (
        typeof resolved.lat === "number" &&
        Number.isFinite(resolved.lat) &&
        typeof resolved.lon === "number" &&
        Number.isFinite(resolved.lon)
      ) {
        return { lat: resolved.lat, lon: resolved.lon };
      }
    } else {
      const resolved = await resolveLocationFromQuery(rawInput);
      if (
        typeof resolved.lat === "number" &&
        Number.isFinite(resolved.lat) &&
        typeof resolved.lon === "number" &&
        Number.isFinite(resolved.lon)
      ) {
        return { lat: resolved.lat, lon: resolved.lon };
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchForecast(
  place: SavedPlace | null
): Promise<WeatherPayload> {
  const coordinates = await resolveForecastCoordinates(place);
  return await getWeather(coordinates ?? undefined);
}

function inferNightFromCondition(value: string | undefined): boolean {
  const text = String(value || "").toLowerCase();
  return /(night|overnight|tonight|evening|late)/.test(text);
}

function inferPlaceLabelPreset(value: string): PlaceLabelPreset {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "Custom";
  const matched = PLACE_LABEL_PRESETS.find(
    (preset) => preset.toLowerCase() === normalized
  );
  return matched ?? "Custom";
}

function defaultPresetForNextPlace(placeCount: number): PlaceLabelPreset {
  return PLACE_LABEL_PRESETS[placeCount] ?? "Custom";
}

function resolvePrimaryPlace(
  places: SavedPlace[],
  activePlaceId: string | null
): SavedPlace | null {
  if (activePlaceId) {
    const exact = places.find((place) => place.id === activePlaceId);
    if (exact) return exact;
  }
  return places.find((place) => place.isPrimary) ?? places[0] ?? null;
}

function isStandalonePwaDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  const matchMediaStandalone = window.matchMedia?.("(display-mode: standalone)")
    .matches;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean })
    .standalone;
  return matchMediaStandalone || iosStandalone === true;
}

function formatReconnectTime(value: string | null): string {
  if (!value) return "just now";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "just now";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(parsed));
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const alertDetailMatch = useMatch("/alerts/:alertId");
  const historyMatch = useMatch("/history");
  const forecastMatch = useMatch("/forecast");
  const settingsMatch = useMatch("/settings");
  const activeTab = forecastMatch ? "forecast" : settingsMatch ? "more" : "alerts";
  const isAlertDetailRoute = Boolean(alertDetailMatch);
  const isHistoryRoute = Boolean(historyMatch);

  const [payload, setPayload] = useState<AlertsPayload | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [forecastData, setForecastData] = useState<WeatherPayload | null>(null);
  const [forecastLoadState, setForecastLoadState] =
    useState<ForecastLoadState>("idle");
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [activePlaceId, setActivePlaceId] = useState<string | null>(null);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [locationModalMode, setLocationModalMode] = useState<"add" | "edit">(
    "add"
  );
  const [editingPlaceId, setEditingPlaceId] = useState<string | null>(null);
  const [placeLabel, setPlaceLabel] = useState("");
  const [placeLabelPreset, setPlaceLabelPreset] =
    useState<PlaceLabelPreset>("Custom");
  const [locationInput, setLocationInput] = useState("");
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );
  const [networkRecoveryState, setNetworkRecoveryState] =
    useState<NetworkRecoveryState>(isOffline ? "offline" : "idle");
  const [lastReconnectAt, setLastReconnectAt] = useState<string | null>(null);
  const [isStandaloneInstalled, setIsStandaloneInstalled] = useState(() =>
    isStandalonePwaDisplayMode()
  );
  const [installStatusMessage, setInstallStatusMessage] = useState<string | null>(
    null
  );
  const [pwaUpdateAvailable, setPwaUpdateAvailable] = useState(false);
  const [pwaOfflineReady, setPwaOfflineReady] = useState(false);
  const [alertsRefreshToken, setAlertsRefreshToken] = useState(0);
  const [forecastRefreshToken, setForecastRefreshToken] = useState(0);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [alertsRefreshSettledToken, setAlertsRefreshSettledToken] = useState(0);
  const [forecastRefreshSettledToken, setForecastRefreshSettledToken] = useState(0);
  const [detailRefreshSettledToken, setDetailRefreshSettledToken] = useState(0);
  const [historyRefreshSettledToken, setHistoryRefreshSettledToken] = useState(0);
  const [pendingReconnectTargets, setPendingReconnectTargets] =
    useState<PendingReconnectTargets | null>(null);

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<AlertTypeFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedForecastDayIndex, setSelectedForecastDayIndex] = useState(0);
  const activePlace = useMemo(
    () => resolvePrimaryPlace(places, activePlaceId),
    [activePlaceId, places]
  );
  const mainContentRef = useRef<HTMLElement | null>(null);
  const lastHandledAlertsRefreshTokenRef = useRef(0);
  const alertsRefreshTokenRef = useRef(0);
  const forecastRefreshTokenRef = useRef(0);
  const detailRefreshTokenRef = useRef(0);
  const historyRefreshTokenRef = useRef(0);

  useEffect(() => {
    if (location.pathname !== "/") return;
    const params = new URLSearchParams(location.search);
    const requestedState = toStateCode(params.get("state") || "");
    if (requestedState) {
      navigate(`/alerts?${params.toString()}`, { replace: true });
      return;
    }

    const tab = readSavedActiveTab();
    const route = tab === "forecast" ? "/forecast" : tab === "more" ? "/settings" : "/alerts";
    navigate(route, { replace: true });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const stateFromQuery = toStateCode(
      new URLSearchParams(location.search).get("state") || ""
    );
    if (stateFromQuery) {
      setStateFilter(stateFromQuery);
    }
  }, [location.search]);

  useEffect(() => {
    const storedPlaces = readSavedPlaces();
    if (storedPlaces.length > 0) {
      setLocationModalDismissed(false);
      setPlaces(storedPlaces);
      const primaryPlace = resolvePrimaryPlace(storedPlaces, null);
      setActivePlaceId(primaryPlace?.id ?? null);
      if (primaryPlace) {
        setStateFilter(primaryPlace.stateCode);
      }
      return;
    }
    if (isLocationModalDismissed()) {
      return;
    }
    const defaultPreset = defaultPresetForNextPlace(0);
    setLocationModalMode("add");
    setEditingPlaceId(null);
    setPlaceLabelPreset(defaultPreset);
    setPlaceLabel(defaultPreset === "Custom" ? "" : defaultPreset);
    setLocationInput("");
    setLocationError(null);
    setShowLocationModal(true);
  }, []);

  useEffect(() => {
    if (!activePlace) {
      setStateFilter("all");
      return;
    }
    setStateFilter(activePlace.stateCode);
    setShowFilters(false);
  }, [activePlace?.id, activePlace?.stateCode]);

  useEffect(() => {
    alertsRefreshTokenRef.current = alertsRefreshToken;
  }, [alertsRefreshToken]);

  useEffect(() => {
    forecastRefreshTokenRef.current = forecastRefreshToken;
  }, [forecastRefreshToken]);

  useEffect(() => {
    detailRefreshTokenRef.current = detailRefreshToken;
  }, [detailRefreshToken]);

  useEffect(() => {
    historyRefreshTokenRef.current = historyRefreshToken;
  }, [historyRefreshToken]);

  const handleDetailRefreshSettled = useCallback((token: number) => {
    setDetailRefreshSettledToken((current) => Math.max(current, token));
  }, []);

  const handleHistoryRefreshSettled = useCallback((token: number) => {
    setHistoryRefreshSettledToken((current) => Math.max(current, token));
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
      setInstallStatusMessage(null);
    };

    const handleAppInstalled = () => {
      setInstallPromptEvent(null);
      setIsStandaloneInstalled(true);
      setInstallStatusMessage(
        "Installed successfully. Open Live Weather Alerts from your home screen or app launcher."
      );
    };

    const handleOnline = () => {
      const nextAlertsRefreshToken = alertsRefreshTokenRef.current + 1;
      const nextForecastRefreshToken = forecastRefreshTokenRef.current + 1;
      const nextDetailRefreshToken = detailRefreshTokenRef.current + 1;
      const nextHistoryRefreshToken = historyRefreshTokenRef.current + 1;
      alertsRefreshTokenRef.current = nextAlertsRefreshToken;
      forecastRefreshTokenRef.current = nextForecastRefreshToken;
      detailRefreshTokenRef.current = nextDetailRefreshToken;
      historyRefreshTokenRef.current = nextHistoryRefreshToken;
      setIsOffline(false);
      setNetworkRecoveryState("reconnecting");
      setLastReconnectAt(new Date().toISOString());
      setAlertsRefreshToken(nextAlertsRefreshToken);
      setForecastRefreshToken(nextForecastRefreshToken);
      setDetailRefreshToken(nextDetailRefreshToken);
      setHistoryRefreshToken(nextHistoryRefreshToken);
      setPendingReconnectTargets({
        alerts: nextAlertsRefreshToken,
        forecast: nextForecastRefreshToken,
        detail: nextDetailRefreshToken,
        history: nextHistoryRefreshToken
      });
    };
    const handleOffline = () => {
      setIsOffline(true);
      setNetworkRecoveryState("offline");
      setPendingReconnectTargets(null);
    };
    const handlePwaUpdateAvailable = () => {
      setPwaUpdateAvailable(true);
    };
    const handlePwaOfflineReady = () => {
      setPwaOfflineReady(true);
    };
    const handleDisplayModeChange = () => {
      setIsStandaloneInstalled(isStandalonePwaDisplayMode());
    };
    const displayModeMediaQuery = window.matchMedia?.("(display-mode: standalone)");

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, handlePwaUpdateAvailable);
    window.addEventListener(PWA_OFFLINE_READY_EVENT, handlePwaOfflineReady);
    window.addEventListener("focus", handleDisplayModeChange);
    displayModeMediaQuery?.addEventListener?.("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener(
        PWA_UPDATE_AVAILABLE_EVENT,
        handlePwaUpdateAvailable
      );
      window.removeEventListener(PWA_OFFLINE_READY_EVENT, handlePwaOfflineReady);
      window.removeEventListener("focus", handleDisplayModeChange);
      displayModeMediaQuery?.removeEventListener?.(
        "change",
        handleDisplayModeChange
      );
    };
  }, []);

  useEffect(() => {
    if (networkRecoveryState !== "reconnecting" || !pendingReconnectTargets) return;
    const alertsLoaded =
      isAlertDetailRoute || isHistoryRoute
        ? true
        : alertsRefreshSettledToken >= pendingReconnectTargets.alerts;
    const forecastLoaded =
      activeTab !== "forecast" ||
      forecastRefreshSettledToken >= pendingReconnectTargets.forecast;
    const detailLoaded =
      !isAlertDetailRoute ||
      detailRefreshSettledToken >= pendingReconnectTargets.detail;
    const historyLoaded =
      !isHistoryRoute ||
      historyRefreshSettledToken >= pendingReconnectTargets.history;
    if (!alertsLoaded || !forecastLoaded || !detailLoaded || !historyLoaded) return;

    setPendingReconnectTargets(null);
    setNetworkRecoveryState("reconnected");
  }, [
    activeTab,
    alertsRefreshSettledToken,
    detailRefreshSettledToken,
    forecastRefreshSettledToken,
    historyRefreshSettledToken,
    isAlertDetailRoute,
    isHistoryRoute,
    networkRecoveryState,
    pendingReconnectTargets
  ]);

  useEffect(() => {
    if (networkRecoveryState !== "reconnected") return;
    const timeoutId = window.setTimeout(() => {
      setNetworkRecoveryState((current) =>
        current === "reconnected" ? "idle" : current
      );
    }, 4500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [networkRecoveryState]);

  useEffect(() => {
    if (!mainContentRef.current) return;
    mainContentRef.current.focus();
  }, [location.pathname, location.search]);

  useEffect(() => {
    saveActiveTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (isAlertDetailRoute || isHistoryRoute) return;
    const hasRefreshRequest =
      alertsRefreshToken !== lastHandledAlertsRefreshTokenRef.current;
    if (!hasRefreshRequest && (payload || errorMessage)) return;
    if (hasRefreshRequest) {
      lastHandledAlertsRefreshTokenRef.current = alertsRefreshToken;
    }

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setLoadState("loading");
      try {
        const data = await getAlerts(controller.signal);
        if (cancelled) return;
        setPayload(data);
        setErrorMessage(null);
        setLoadState("ready");
        setAlertsRefreshSettledToken(alertsRefreshToken);
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load weather alerts.";
        setErrorMessage(message);
        setLoadState("error");
        setAlertsRefreshSettledToken(alertsRefreshToken);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    alertsRefreshToken,
    errorMessage,
    isAlertDetailRoute,
    isHistoryRoute,
    payload
  ]);

  useEffect(() => {
    if (activeTab !== "forecast") return;

    let cancelled = false;

    const loadForecast = async () => {
      setForecastLoadState("loading");
      setForecastError(null);
      try {
        const forecast = await fetchForecast(activePlace);
        if (cancelled) return;
        setForecastData(forecast);
        setForecastLoadState("ready");
        setForecastRefreshSettledToken(forecastRefreshToken);
      } catch (error) {
        if (cancelled) return;
        setForecastError(
          error instanceof Error ? error.message : "Unable to load forecast."
        );
        setForecastLoadState("error");
        setForecastRefreshSettledToken(forecastRefreshToken);
      }
    };

    void loadForecast();

    return () => {
      cancelled = true;
    };
  }, [activePlace, activeTab, forecastRefreshToken]);

  const alerts = payload?.alerts ?? [];

  const states = useMemo(() => {
    const values = new Set(
      alerts.map((alert) => alert.stateCode.trim().toUpperCase()).filter(Boolean)
    );
    if (stateFilter !== "all") {
      values.add(stateFilter);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [alerts, stateFilter]);

  const activeCountyName =
    stateFilter !== "all" && activePlace?.stateCode === stateFilter
      ? activePlace.countyName ?? ""
      : "";
  const activeCountyCode =
    stateFilter !== "all" && activePlace?.stateCode === stateFilter
      ? activePlace.countyCode ?? ""
      : "";

  const filteredAlerts = useMemo(() => {
    const search = query.trim().toLowerCase();

    return alerts.filter((alert) => {
      const type = classifyAlertType(alert.event);
      const severity = normalizeSeverity(alert.severity);
      const state = alert.stateCode.trim().toUpperCase() || "US";
      const textBlob = [
        alert.event,
        alert.areaDesc,
        alert.headline,
        alert.description,
        alert.instruction,
        alert.severity,
        alert.urgency,
        alert.certainty
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch = !search || textBlob.includes(search);
      const matchesState = stateFilter === "all" || state === stateFilter;
      const matchesType = typeFilter === "all" || type === typeFilter;
      const matchesSeverity =
        severityFilter === "all" || severity === severityFilter;
      const matchesCounty =
        (!activeCountyName && !activeCountyCode) ||
        alertMatchesCounty(alert, state, activeCountyName, activeCountyCode);

      return (
        matchesSearch &&
        matchesState &&
        matchesType &&
        matchesSeverity &&
        matchesCounty
      );
    });
  }, [
    activeCountyCode,
    activeCountyName,
    alerts,
    query,
    severityFilter,
    stateFilter,
    typeFilter
  ]);

  const sortedAlerts = useMemo(() => {
    const items = [...filteredAlerts];
    items.sort((a, b) => {
      if (sortMode === "priority") {
        return priorityScore(b) - priorityScore(a);
      }

      if (sortMode === "expires") {
        const expiresA = parseTime(a.expires) ?? Number.MAX_SAFE_INTEGER;
        const expiresB = parseTime(b.expires) ?? Number.MAX_SAFE_INTEGER;
        return expiresA - expiresB;
      }

      const updatedA = parseTime(a.updated) ?? parseTime(a.sent) ?? 0;
      const updatedB = parseTime(b.updated) ?? parseTime(b.sent) ?? 0;
      return updatedB - updatedA;
    });
    return items;
  }, [filteredAlerts, sortMode]);

  const warningCount = useMemo(
    () => alerts.filter((alert) => classifyAlertType(alert.event) === "warning")
      .length,
    [alerts]
  );

  const watchCount = useMemo(
    () => alerts.filter((alert) => classifyAlertType(alert.event) === "watch").length,
    [alerts]
  );

  const expiringSoonCount = useMemo(
    () =>
      alerts.filter((alert) => {
        const expiresAt = parseTime(alert.expires);
        if (!expiresAt) return false;
        const diff = expiresAt - Date.now();
        return diff >= 0 && diff <= 2 * 60 * 60 * 1000;
      }).length,
    [alerts]
  );

  const installPwa = async () => {
    if (isStandaloneInstalled) {
      setInstallStatusMessage("Live Weather Alerts is already installed on this device.");
      return;
    }

    if (!installPromptEvent) {
      setInstallStatusMessage(
        "Install prompt is not available yet. Use your browser menu to install this app."
      );
      return;
    }

    setInstallStatusMessage(null);
    try {
      await installPromptEvent.prompt();
      const result = await installPromptEvent.userChoice;
      if (result.outcome === "accepted") {
        setInstallPromptEvent(null);
        setInstallStatusMessage(
          "Install accepted. Finishing setup and syncing offline support..."
        );
        return;
      }
      setInstallStatusMessage(
        "Install was dismissed. You can retry from this screen any time."
      );
    } catch {
      setInstallStatusMessage(
        "Install request could not be completed. Retry in a moment."
      );
    }
  };

  const applyUpdate = async () => {
    const applied = await applyPwaUpdate();
    if (!applied) {
      setPwaUpdateAvailable(false);
      setInstallStatusMessage(
        "No pending update was found. You are already on the latest version."
      );
    }
  };

  const commitPlaces = (nextPlaces: SavedPlace[]) => {
    const persistedPlaces = writeSavedPlaces(nextPlaces);
    setPlaces(persistedPlaces);
    const primaryPlace = resolvePrimaryPlace(persistedPlaces, null);
    setActivePlaceId(primaryPlace?.id ?? null);
  };

  const openAddPlaceModal = () => {
    const nextPreset = defaultPresetForNextPlace(places.length);
    setLocationModalMode("add");
    setEditingPlaceId(null);
    setPlaceLabelPreset(nextPreset);
    setPlaceLabel(nextPreset === "Custom" ? "" : nextPreset);
    setLocationError(null);
    setLocationInput(
      activePlace?.rawInput ?? (stateFilter === "all" ? "" : stateFilter)
    );
    setLocationModalDismissed(false);
    setShowLocationModal(true);
  };

  const openEditPlaceModal = (placeId: string) => {
    const place = places.find((item) => item.id === placeId);
    if (!place) return;
    setLocationModalMode("edit");
    setEditingPlaceId(place.id);
    setPlaceLabel(place.label);
    setPlaceLabelPreset(inferPlaceLabelPreset(place.label));
    setLocationInput(place.rawInput);
    setLocationError(null);
    setLocationModalDismissed(false);
    setShowLocationModal(true);
  };

  const handleSetPrimaryPlace = (placeId: string) => {
    const nextPlaces = setPrimarySavedPlace(places, placeId);
    commitPlaces(nextPlaces);
  };

  const handleRemovePlace = (placeId: string) => {
    const nextPlaces = removeSavedPlaceById(places, placeId);
    commitPlaces(nextPlaces);
    if (nextPlaces.length === 0 && !isLocationModalDismissed()) {
      openAddPlaceModal();
    }
  };

  const handleRenamePlace = (placeId: string, nextLabel: string) => {
    const existing = places.find((place) => place.id === placeId);
    if (!existing) return;

    const updated = upsertSavedPlace(places, {
      ...existing,
      label: nextLabel
    });
    commitPlaces(updated);
  };

  const handlePlaceLabelPresetChange = (value: PlaceLabelPreset) => {
    setPlaceLabelPreset(value);
    if (value !== "Custom") {
      setPlaceLabel(value);
    }
  };

  const handlePlaceLabelChange = (value: string) => {
    setPlaceLabel(value);
    setPlaceLabelPreset(inferPlaceLabelPreset(value));
  };

  const handleLocationExit = () => {
    setLocationError(null);
    setShowLocationModal(false);
    if (locationModalMode === "add" && places.length === 0) {
      setLocationModalDismissed(true);
    }
  };

  const handleLocationSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rawInput = locationInput.trim();

    if (!rawInput) {
      setLocationError("Enter City, State, State, or ZIP code.");
      return;
    }

    setLocationError(null);
    setIsSavingLocation(true);

    try {
      let stateCode: string | null = null;
      let label = rawInput;
      let countyName: string | undefined;
      let countyCode: string | undefined;
      let lat: number | undefined;
      let lon: number | undefined;

      if (/^\d{5}$/.test(rawInput)) {
        const resolved = await resolveStateFromZip(rawInput);
        stateCode = resolved.stateCode;
        label = resolved.label;
        countyName = resolved.countyName;
        countyCode = resolved.countyCode;
        lat = resolved.lat;
        lon = resolved.lon;
      } else if (isLikelyStateOnlyInput(rawInput)) {
        stateCode = toStateCode(rawInput);
      } else {
        const resolved = await resolveLocationFromQuery(rawInput);
        stateCode = resolved.stateCode;
        label = resolved.label;
        countyName = resolved.countyName;
        countyCode = resolved.countyCode;
        lat = resolved.lat;
        lon = resolved.lon;
      }

      if (!stateCode) {
        stateCode = resolveStateFromText(rawInput);
      }

      if (!stateCode) {
        throw new Error(
          "Could not determine a state from that entry. Use format like \"Louisville, KY\", \"Kentucky\", or \"40202\"."
        );
      }

      const existingPlace = editingPlaceId
        ? places.find((place) => place.id === editingPlaceId)
        : undefined;
      const resolvedLabel =
        placeLabel.trim() ||
        (placeLabelPreset === "Custom" ? "" : placeLabelPreset) ||
        label ||
        stateCode;
      const candidatePlace = createSavedPlaceFromResolvedLocation({
        id: existingPlace?.id,
        stateCode,
        rawInput,
        label: resolvedLabel,
        countyName,
        countyCode,
        lat,
        lon,
        isPrimary: existingPlace ? existingPlace.isPrimary : places.length === 0
      });
      const nextPlaces = upsertSavedPlace(places, {
        ...candidatePlace,
        createdAt: existingPlace?.createdAt ?? candidatePlace.createdAt
      });

      commitPlaces(nextPlaces);
      setLocationModalDismissed(false);
      setShowLocationModal(false);
      setEditingPlaceId(null);
    } catch (error) {
      setLocationError(
        error instanceof Error
          ? error.message
          : "Unable to save that location right now."
      );
    } finally {
      setIsSavingLocation(false);
    }
  };

  const forecastStateCode = (
    forecastData?.location?.state ||
    activePlace?.stateCode ||
    (stateFilter !== "all" ? stateFilter : "")
  )
    .trim()
    .toUpperCase();
  const forecastCountyName =
    activePlace?.stateCode === forecastStateCode
      ? activePlace.countyName ?? ""
      : "";
  const forecastCountyCode =
    activePlace?.stateCode === forecastStateCode
      ? activePlace.countyCode ?? ""
      : "";
  const forecastScopedAlerts = useMemo(() => {
    if (!forecastStateCode) return [] as AlertRecord[];

    return alerts.filter((alert) => {
      const state = alert.stateCode.trim().toUpperCase() || "US";
      if (state !== forecastStateCode) return false;
      if (!forecastCountyName && !forecastCountyCode) return true;
      return alertMatchesCounty(alert, state, forecastCountyName, forecastCountyCode);
    });
  }, [alerts, forecastCountyCode, forecastCountyName, forecastStateCode]);

  const openAlertFromForecast = (alert: AlertRecord) => {
    navigate(canonicalAlertDetailPath(alert));
  };

  const forecastLocation =
    forecastData?.location?.label || activePlace?.label || "Primary place";
  const hourlyForecast = (forecastData?.hourly ?? []).slice(0, 12);
  const dailyForecast = (forecastData?.daily ?? []).slice(0, 7);
  const dayWindows = useMemo(
    () =>
      dailyForecast.map((day, index) => {
        const startMs = parseTime(day.startTime || "");
        const nextStartMs =
          index < dailyForecast.length - 1
            ? parseTime(dailyForecast[index + 1]?.startTime || "")
            : null;
        const endMs =
          startMs !== null
            ? nextStartMs && nextStartMs > startMs
              ? nextStartMs
              : startMs + 24 * 60 * 60 * 1000
            : null;
        return { startMs, endMs };
      }),
    [dailyForecast]
  );
  const forecastAlertsByDay = useMemo(() => {
    const buckets = dayWindows.map(() => [] as AlertRecord[]);

    for (const alert of forecastScopedAlerts) {
      const startMs = alertEffectiveStartMs(alert);
      if (startMs === null) continue;
      const parsedEndMs = alertEffectiveEndMs(alert);
      const endMs = parsedEndMs !== null && parsedEndMs > startMs ? parsedEndMs : startMs + 1;

      let firstMatch = -1;
      for (let dayIndex = 0; dayIndex < dayWindows.length; dayIndex += 1) {
        const window = dayWindows[dayIndex];
        if (window.startMs === null || window.endMs === null) continue;

        const overlapStart = Math.max(startMs, window.startMs);
        const overlapEnd = Math.min(endMs, window.endMs);
        const overlapMs = overlapEnd - overlapStart;
        if (overlapMs <= 0) continue;

        if (firstMatch === -1) {
          buckets[dayIndex].push(alert);
          firstMatch = dayIndex;
          continue;
        }

        if (overlapMs >= FORECAST_ALERT_CARRYOVER_MS) {
          buckets[dayIndex].push(alert);
        }
      }
    }

    return buckets.map((dayAlerts) => {
      const seen = new Set<string>();
      return dayAlerts.filter((alert) => {
        if (seen.has(alert.id)) return false;
        seen.add(alert.id);
        return true;
      });
    });
  }, [dayWindows, forecastScopedAlerts]);

  useEffect(() => {
    setSelectedForecastDayIndex(0);
  }, [dailyForecast.length, dailyForecast[0]?.startTime]);

  const clampedSelectedForecastDayIndex =
    selectedForecastDayIndex >= 0 && selectedForecastDayIndex < dailyForecast.length
      ? selectedForecastDayIndex
      : 0;
  const selectedForecastDay = dailyForecast[clampedSelectedForecastDayIndex];
  const selectedForecastAlerts =
    forecastAlertsByDay[clampedSelectedForecastDayIndex] ?? [];
  const todayForecast = dailyForecast[0];
  const currentCondition = forecastData?.current?.condition || "Conditions unavailable";
  const currentIsNight =
    typeof forecastData?.current?.isNight === "boolean"
      ? forecastData.current.isNight
      : inferNightFromCondition(currentCondition);

  const goToTab = (tab: "alerts" | "forecast" | "more") => {
    if (tab === "alerts") {
      navigate("/alerts");
      return;
    }
    if (tab === "forecast") {
      navigate("/forecast");
      return;
    }
    navigate("/settings");
  };

  return (
    <div className="page-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="background-orb orb-one" />
      <div className="background-orb orb-two" />
      <main
        id="main-content"
        className="app-shell"
        ref={mainContentRef}
        tabIndex={-1}
        aria-label="Live Weather Alerts main content"
      >
        {networkRecoveryState === "offline" ? (
          <section className="message offline-message" role="status" aria-live="polite">
            You are offline. Core alert and history views will use cached data until
            reconnect.
          </section>
        ) : null}
        {networkRecoveryState === "reconnecting" ? (
          <section className="message warning-message" role="status" aria-live="polite">
            Connection restored. Refreshing alerts, forecast, and route details now...
          </section>
        ) : null}
        {networkRecoveryState === "reconnected" ? (
          <section className="message offline-message" role="status" aria-live="polite">
            Live updates restored at {formatReconnectTime(lastReconnectAt)}.
          </section>
        ) : null}
        {pwaUpdateAvailable ? (
          <section className="install-banner" role="status" aria-live="polite">
            <p>
              A new version is ready with the latest fixes. Update now to refresh the
              app shell and offline cache.
            </p>
            <div className="install-actions">
              <button type="button" className="save-location-btn" onClick={() => void applyUpdate()}>
                Update now
              </button>
            </div>
          </section>
        ) : null}
        <header className="site-header">
          <div>
            <p className="eyebrow">LiveWeatherAlerts.com</p>
            <h1>Weather Alerts</h1>
            <p className="subtitle">
              Focused, readable, real-time severe weather alerts from NOAA/NWS.
            </p>
            <div className="place-switcher">
              <label htmlFor="primary-place-select">Primary place</label>
              <div className="place-switcher-controls">
                <select
                  id="primary-place-select"
                  value={activePlace?.id ?? ""}
                  onChange={(event) => handleSetPrimaryPlace(event.target.value)}
                  disabled={places.length === 0}
                >
                  {places.length === 0 ? (
                    <option value="">No saved places</option>
                  ) : (
                    places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.label} ({place.stateCode})
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  className="text-btn"
                  onClick={openAddPlaceModal}
                >
                  Add place
                </button>
              </div>
            </div>
          </div>
        </header>

        {activeTab === "alerts" ? (
          isAlertDetailRoute ? (
            <AlertDetailPage
              isOffline={isOffline}
              savedPlace={activePlace}
              refreshToken={detailRefreshToken}
              onRefreshSettled={handleDetailRefreshSettled}
            />
          ) : isHistoryRoute ? (
            <AlertHistoryPage
              isOffline={isOffline}
              activePlace={activePlace}
              refreshToken={historyRefreshToken}
              onRefreshSettled={handleHistoryRefreshSettled}
            />
          ) : (
            <AlertsPage
              isOffline={isOffline}
              alertsMeta={payload?.meta ?? null}
              alerts={alerts}
              sortedAlerts={sortedAlerts}
              states={states}
              query={query}
              stateFilter={stateFilter}
              typeFilter={typeFilter}
              severityFilter={severityFilter}
              sortMode={sortMode}
              showFilters={showFilters}
              changeSummaryStorageKey={activePlace?.id ?? ""}
              changeSummaryStateCode={activePlace?.stateCode ?? ""}
              changeSummaryCountyCode={activePlace?.countyCode ?? ""}
              changeSummaryLabel={activePlace?.label || "Primary place"}
              loadState={loadState}
              errorMessage={errorMessage}
              warningCount={warningCount}
              watchCount={watchCount}
              expiringSoonCount={expiringSoonCount}
              onQueryChange={setQuery}
              onStateFilterChange={setStateFilter}
              onTypeFilterChange={setTypeFilter}
              onSeverityFilterChange={setSeverityFilter}
              onSortModeChange={setSortMode}
              onShowFiltersChange={setShowFilters}
            />
          )
        ) : null}

        {activeTab === "forecast" ? (
          <ForecastPage
            isOffline={isOffline}
            alertsMeta={payload?.meta ?? null}
            forecastLoadState={forecastLoadState}
            forecastData={forecastData}
            forecastError={forecastError}
            forecastLocation={forecastLocation}
            currentCondition={currentCondition}
            currentIsNight={currentIsNight}
            todayForecast={todayForecast}
            hourlyForecast={hourlyForecast}
            dailyForecast={dailyForecast}
            selectedForecastDayIndex={clampedSelectedForecastDayIndex}
            selectedForecastDay={selectedForecastDay}
            selectedForecastAlerts={selectedForecastAlerts}
            forecastAlertsByDay={forecastAlertsByDay}
            onSelectForecastDay={setSelectedForecastDayIndex}
            onOpenAlertFromForecast={openAlertFromForecast}
          />
        ) : null}

        {activeTab === "more" ? (
          <SettingsPage
            places={places}
            activePlaceId={activePlace?.id ?? null}
            installPromptAvailable={Boolean(installPromptEvent)}
            isStandaloneInstalled={isStandaloneInstalled}
            installStatusMessage={installStatusMessage}
            pwaUpdateAvailable={pwaUpdateAvailable}
            pwaOfflineReady={pwaOfflineReady}
            onInstallPwa={installPwa}
            onApplyUpdate={applyUpdate}
            onOpenAddPlaceModal={openAddPlaceModal}
            onEditPlace={openEditPlaceModal}
            onRemovePlace={handleRemovePlace}
            onSetPrimaryPlace={handleSetPrimaryPlace}
            onRenamePlace={handleRenamePlace}
          />
        ) : null}

        <nav className="bottom-nav" aria-label="Primary">
          <button
            type="button"
            className={`bottom-nav-item${activeTab === "alerts" ? " active" : ""}`}
            aria-current={activeTab === "alerts" ? "page" : undefined}
            onClick={() => goToTab("alerts")}
          >
            Alerts
          </button>
          <button
            type="button"
            className={`bottom-nav-item${activeTab === "forecast" ? " active" : ""}`}
            aria-current={activeTab === "forecast" ? "page" : undefined}
            onClick={() => goToTab("forecast")}
          >
            Forecast
          </button>
          <button
            type="button"
            className={`bottom-nav-item${activeTab === "more" ? " active" : ""}`}
            aria-current={activeTab === "more" ? "page" : undefined}
            onClick={() => goToTab("more")}
          >
            More
          </button>
        </nav>

        <LocationModal
          isOpen={showLocationModal}
          mode={locationModalMode}
          placeLabel={placeLabel}
          placeLabelPreset={placeLabelPreset}
          locationInput={locationInput}
          locationError={locationError}
          isSavingLocation={isSavingLocation}
          onPlaceLabelPresetChange={handlePlaceLabelPresetChange}
          onPlaceLabelChange={handlePlaceLabelChange}
          onInputChange={setLocationInput}
          onSubmit={handleLocationSubmit}
          onClose={handleLocationExit}
        />
        <Outlet />
      </main>
    </div>
  );
}
