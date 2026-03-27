import { useCallback, useEffect, useMemo, useState } from "react";
import {
  sendTestPush,
  subscribePush,
  unsubscribePush,
  getPushPublicKey
} from "../../../lib/api/push";
import {
  getExistingPushSubscription,
  getNotificationPermissionStatus,
  isPushSupported,
  requestNotificationPermission,
  subscribeBrowserPush
} from "../../../lib/pwa/push";
import type {
  PushAlertTypes,
  PushPreferences,
  PushScope,
  SavedPlace
} from "../../../types";

const PUSH_PREFS_STORAGE_KEY = "lwa:push-prefs:v2";
const PLACE_SCOPE_ID_PREFIX = "place:";

const DEFAULT_ALERT_TYPES: PushAlertTypes = {
  warnings: true,
  watches: true,
  advisories: false,
  statements: true
};

function normalizeStateCode(input: unknown): string | null {
  const value = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return value.length === 2 ? value : null;
}

function normalizeCountyFips(input: unknown): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(3, "0").slice(-3);
}

function normalizeCountyName(input: unknown): string | null {
  const value = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ county$/, "");
  return value || null;
}

function normalizePushAlertTypes(input: unknown): PushAlertTypes {
  const value = (input || {}) as Record<string, unknown>;
  return {
    warnings: value.warnings !== false,
    watches: value.watches !== false,
    advisories: value.advisories === true,
    statements: value.statements !== false
  };
}

function normalizeTime(input: unknown, fallback: string): string {
  const value = String(input ?? "").trim();
  if (!/^\d{2}:\d{2}$/.test(value)) return fallback;
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizePlaceId(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value ? value : null;
}

function createCustomScopeId(stateCode: string): string {
  return `custom:${stateCode}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}

function createPlaceScopeId(placeId: string): string {
  return `${PLACE_SCOPE_ID_PREFIX}${placeId}`;
}

function isPlaceScope(scope: PushScope): boolean {
  return Boolean(scope.placeId) || scope.id.startsWith(PLACE_SCOPE_ID_PREFIX);
}

function placeHasCountyData(place: SavedPlace): boolean {
  const countyCode = normalizeCountyFips(place.countyCode);
  const countyName = String(place.countyName || "").trim();
  return Boolean(countyCode || countyName);
}

function buildPlaceScope(place: SavedPlace, sourceScope?: PushScope): PushScope {
  const stateCode =
    normalizeStateCode(place.stateCode) ||
    normalizeStateCode(sourceScope?.stateCode) ||
    "KY";
  const countyFips = normalizeCountyFips(place.countyCode);
  const countyName =
    typeof place.countyName === "string" && place.countyName.trim()
      ? place.countyName.trim()
      : null;
  const canUseCounty = Boolean(countyFips || countyName);
  const deliveryScope = sourceScope
    ? sourceScope.deliveryScope === "county" && canUseCounty
      ? "county"
      : "state"
    : canUseCounty
      ? "county"
      : "state";

  return {
    id: createPlaceScopeId(place.id),
    placeId: place.id,
    label: place.label.trim() || `${stateCode} Alerts`,
    stateCode,
    deliveryScope,
    countyName: canUseCounty ? countyName : null,
    countyFips: canUseCounty ? countyFips : null,
    enabled: sourceScope ? sourceScope.enabled !== false : true,
    alertTypes: sourceScope
      ? normalizePushAlertTypes(sourceScope.alertTypes)
      : { ...DEFAULT_ALERT_TYPES },
    severeOnly: sourceScope?.severeOnly === true
  };
}

function createFallbackScope(stateCode: string): PushScope {
  return {
    id: createCustomScopeId(stateCode),
    placeId: null,
    label: `${stateCode} Alerts`,
    stateCode,
    deliveryScope: "state",
    countyName: null,
    countyFips: null,
    enabled: true,
    alertTypes: { ...DEFAULT_ALERT_TYPES },
    severeOnly: false
  };
}

function isExactCountyMatch(scope: PushScope, place: SavedPlace): boolean {
  const placeCountyFips = normalizeCountyFips(place.countyCode);
  const scopeCountyFips = normalizeCountyFips(scope.countyFips);
  if (placeCountyFips && scopeCountyFips) {
    return placeCountyFips === scopeCountyFips;
  }

  const placeCountyName = normalizeCountyName(place.countyName);
  const scopeCountyName = normalizeCountyName(scope.countyName);
  if (placeCountyName && scopeCountyName) {
    return placeCountyName === scopeCountyName;
  }

  return false;
}

function scopeMatchesPlace(scope: PushScope, place: SavedPlace): boolean {
  const scopeState = normalizeStateCode(scope.stateCode);
  const placeState = normalizeStateCode(place.stateCode);
  if (!scopeState || !placeState || scopeState !== placeState) {
    return false;
  }

  const hasCountyHints =
    scope.deliveryScope === "county" ||
    Boolean(normalizeCountyFips(scope.countyFips) || normalizeCountyName(scope.countyName));
  if (!hasCountyHints) {
    return false;
  }

  // Legacy custom scopes are only auto-linked to places when county data matches exactly.
  return isExactCountyMatch(scope, place);
}

function resolveActivePlace(
  places: SavedPlace[],
  activePlaceId: string | null
): SavedPlace | null {
  if (activePlaceId) {
    const exact = places.find((place) => place.id === activePlaceId);
    if (exact) return exact;
  }
  return places.find((place) => place.isPrimary) ?? places[0] ?? null;
}

function createDefaultPreferences(
  places: SavedPlace[],
  activePlaceId: string | null
): PushPreferences {
  const activePlace = resolveActivePlace(places, activePlaceId);
  const placeScopes = places.map((place) => buildPlaceScope(place));
  const fallbackState = normalizeStateCode(activePlace?.stateCode) || "KY";
  const scopes = placeScopes.length > 0 ? placeScopes : [createFallbackScope(fallbackState)];

  return {
    scopes,
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "06:00"
    },
    deliveryMode: "immediate",
    pausedUntil: null
  };
}

function normalizeScope(raw: unknown, fallbackStateCode: string): PushScope | null {
  const value = (raw || {}) as Record<string, unknown>;
  const stateCode =
    normalizeStateCode(value.stateCode) || normalizeStateCode(fallbackStateCode);
  if (!stateCode) return null;

  const countyFips = normalizeCountyFips(value.countyFips);
  const countyName =
    typeof value.countyName === "string" && value.countyName.trim()
      ? value.countyName.trim()
      : null;
  const requestedScope = value.deliveryScope === "county" ? "county" : "state";
  const deliveryScope =
    requestedScope === "county" && (countyFips || countyName) ? "county" : "state";
  const placeId = normalizePlaceId(value.placeId);

  return {
    id:
      String(value.id || "").trim() ||
      (placeId ? createPlaceScopeId(placeId) : createCustomScopeId(stateCode)),
    placeId,
    label: String(value.label || `${stateCode} Alerts`).trim() || `${stateCode} Alerts`,
    stateCode,
    deliveryScope,
    countyName: deliveryScope === "county" ? countyName : null,
    countyFips: deliveryScope === "county" ? countyFips : null,
    enabled: value.enabled !== false,
    alertTypes: normalizePushAlertTypes(value.alertTypes),
    severeOnly: value.severeOnly === true
  };
}

function normalizePreferences(
  raw: unknown,
  fallback: PushPreferences
): PushPreferences {
  const value = (raw || {}) as Record<string, unknown>;
  const quietHours =
    value.quietHours && typeof value.quietHours === "object"
      ? (value.quietHours as Record<string, unknown>)
      : null;
  const fallbackState = fallback.scopes[0]?.stateCode || "KY";
  const scopesRaw = Array.isArray(value.scopes) ? value.scopes : [];
  const normalizedScopes = scopesRaw
    .map((scope) => normalizeScope(scope, fallbackState))
    .filter((scope): scope is PushScope => Boolean(scope));
  const scopes = normalizedScopes.length > 0 ? normalizedScopes : fallback.scopes;

  return {
    scopes,
    quietHours: {
      enabled: quietHours?.enabled === true,
      start: normalizeTime(quietHours?.start, fallback.quietHours.start),
      end: normalizeTime(quietHours?.end, fallback.quietHours.end)
    },
    deliveryMode: value.deliveryMode === "digest" ? "digest" : "immediate",
    pausedUntil:
      typeof value.pausedUntil === "string" && value.pausedUntil.trim()
        ? value.pausedUntil.trim()
        : null
  };
}

function readStoredPreferences(fallback: PushPreferences): PushPreferences {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PUSH_PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return normalizePreferences(parsed, fallback);
  } catch {
    return fallback;
  }
}

function writeStoredPreferences(prefs: PushPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage restrictions.
  }
}

function serializePushSubscription(subscription: PushSubscription): Record<string, unknown> {
  const json = subscription.toJSON?.();
  if (!json || typeof json !== "object") {
    throw new Error("Unable to serialize browser push subscription.");
  }
  return json as Record<string, unknown>;
}

function resolvePrimaryStateCode(prefs: PushPreferences): string | null {
  const enabled = prefs.scopes.find((scope) => scope.enabled);
  if (enabled) {
    return normalizeStateCode(enabled.stateCode);
  }
  const first = prefs.scopes[0];
  return first ? normalizeStateCode(first.stateCode) : null;
}

function reconcilePlaceScopes(
  prefs: PushPreferences,
  places: SavedPlace[],
  activePlaceId: string | null
): PushPreferences {
  const scopes = prefs.scopes;
  const usedScopeIndexes = new Set<number>();

  const nextPlaceScopes = places.map((place) => {
    const matchIndex = scopes.findIndex((scope, index) => {
      if (usedScopeIndexes.has(index)) return false;
      if (scope.placeId === place.id) return true;
      if (scope.id === createPlaceScopeId(place.id)) return true;
      return !isPlaceScope(scope) && scopeMatchesPlace(scope, place);
    });

    const sourceScope = matchIndex >= 0 ? scopes[matchIndex] : undefined;
    if (matchIndex >= 0) {
      usedScopeIndexes.add(matchIndex);
    }
    return buildPlaceScope(place, sourceScope);
  });

  const legacyScopes = scopes.filter(
    (scope, index) => !usedScopeIndexes.has(index) && !isPlaceScope(scope)
  );
  const nextScopes = [...nextPlaceScopes, ...legacyScopes];
  if (nextScopes.length > 0) {
    return {
      ...prefs,
      scopes: nextScopes
    };
  }

  const fallback = createDefaultPreferences(places, activePlaceId);
  return {
    ...prefs,
    scopes: fallback.scopes
  };
}

function arePrefsEqual(a: PushPreferences, b: PushPreferences): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function usePushNotifications(
  places: SavedPlace[],
  activePlaceId: string | null
) {
  const fallbackPreferences = useMemo(
    () => createDefaultPreferences(places, activePlaceId),
    [activePlaceId, places]
  );
  const [supported] = useState(() => isPushSupported());
  const [permission, setPermission] = useState(() =>
    getNotificationPermissionStatus()
  );
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [prefs, setPrefs] = useState<PushPreferences>(() =>
    readStoredPreferences(fallbackPreferences)
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setPrefs((current) => {
      const baseline = current.scopes.length > 0 ? current : fallbackPreferences;
      const reconciled = reconcilePlaceScopes(baseline, places, activePlaceId);
      if (arePrefsEqual(current, reconciled)) {
        return current;
      }
      return reconciled;
    });
  }, [activePlaceId, fallbackPreferences, places]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!supported) {
        setPermission("unsupported");
        setIsLoading(false);
        return;
      }
      try {
        setPermission(getNotificationPermissionStatus());
        const activeSubscription = await getExistingPushSubscription();
        if (!cancelled) {
          setSubscription(activeSubscription);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [supported]);

  useEffect(() => {
    writeStoredPreferences(prefs);
  }, [prefs]);

  const applyServerPreferences = useCallback(
    (incoming: PushPreferences | undefined) => {
      if (!incoming) return;
      const normalized = normalizePreferences(incoming, fallbackPreferences);
      const reconciled = reconcilePlaceScopes(normalized, places, activePlaceId);
      setPrefs(reconciled);
      writeStoredPreferences(reconciled);
    },
    [activePlaceId, fallbackPreferences, places]
  );

  const subscribe = useCallback(async () => {
    setError(null);
    setNotice(null);

    if (!supported) {
      setError("This browser does not support push notifications.");
      return;
    }

    setIsSaving(true);
    try {
      const permissionResult =
        permission === "granted"
          ? permission
          : await requestNotificationPermission();
      setPermission(permissionResult);
      if (permissionResult !== "granted") {
        setError("Browser permission for notifications was not granted.");
        return;
      }

      const keyPayload = await getPushPublicKey();
      const browserSubscription = await subscribeBrowserPush(keyPayload.publicKey);
      const response = await subscribePush({
        subscription: serializePushSubscription(browserSubscription),
        prefs,
        stateCode: resolvePrimaryStateCode(prefs) || undefined
      });

      setSubscription(browserSubscription);
      applyServerPreferences(response.prefs);
      setNotice("Notifications are enabled for this browser.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to enable notifications right now."
      );
    } finally {
      setIsSaving(false);
    }
  }, [applyServerPreferences, permission, prefs, supported]);

  const savePreferences = useCallback(async () => {
    setError(null);
    setNotice(null);
    writeStoredPreferences(prefs);

    if (!subscription) {
      setNotice("Preferences saved locally. Enable notifications to sync to the server.");
      return;
    }

    setIsSaving(true);
    try {
      const response = await subscribePush({
        subscription: serializePushSubscription(subscription),
        prefs,
        stateCode: resolvePrimaryStateCode(prefs) || undefined
      });
      applyServerPreferences(response.prefs);
      setNotice("Notification preferences updated.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to update notification preferences."
      );
    } finally {
      setIsSaving(false);
    }
  }, [applyServerPreferences, prefs, subscription]);

  const unsubscribe = useCallback(async () => {
    setError(null);
    setNotice(null);
    setIsSaving(true);

    try {
      const activeSubscription = subscription || (await getExistingPushSubscription());
      if (!activeSubscription) {
        setNotice("Notifications are already disabled on this browser.");
        setSubscription(null);
        return;
      }

      await unsubscribePush(activeSubscription.endpoint);
      await activeSubscription.unsubscribe();
      setSubscription(null);
      setNotice("Notifications disabled.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to unsubscribe right now."
      );
    } finally {
      setIsSaving(false);
    }
  }, [subscription]);

  const sendTestNotification = useCallback(async () => {
    setError(null);
    setNotice(null);
    const activeSubscription = subscription || (await getExistingPushSubscription());
    if (!activeSubscription) {
      setError("Enable notifications first before sending a test notification.");
      return;
    }

    setIsSendingTest(true);
    try {
      await sendTestPush({
        subscription: serializePushSubscription(activeSubscription),
        prefs,
        stateCode: resolvePrimaryStateCode(prefs) || undefined
      });
      setNotice("Test notification sent.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to send a test notification."
      );
    } finally {
      setIsSendingTest(false);
    }
  }, [prefs, subscription]);

  const addScope = useCallback(() => {
    const activePlace = resolveActivePlace(places, activePlaceId);
    const fallbackState =
      normalizeStateCode(activePlace?.stateCode) ||
      resolvePrimaryStateCode(prefs) ||
      "KY";
    const nextScope: PushScope = {
      id: createCustomScopeId(fallbackState),
      placeId: null,
      label: `${fallbackState} Alerts`,
      stateCode: fallbackState,
      deliveryScope: "state",
      countyName: null,
      countyFips: null,
      enabled: true,
      alertTypes: { ...DEFAULT_ALERT_TYPES },
      severeOnly: false
    };
    setPrefs((current) => ({
      ...current,
      scopes: [...current.scopes, nextScope]
    }));
  }, [activePlaceId, places, prefs]);

  const removeScope = useCallback((scopeId: string) => {
    setPrefs((current) => {
      const targetScope = current.scopes.find((scope) => scope.id === scopeId);
      if (!targetScope || targetScope.placeId) {
        return current;
      }
      const customScopeCount = current.scopes.filter((scope) => !scope.placeId).length;
      if (customScopeCount <= 1) return current;
      return {
        ...current,
        scopes: current.scopes.filter((scope) => scope.id !== scopeId)
      };
    });
  }, []);

  const placeScopes = useMemo(
    () => prefs.scopes.filter((scope) => Boolean(scope.placeId)),
    [prefs.scopes]
  );
  const customScopes = useMemo(
    () => prefs.scopes.filter((scope) => !scope.placeId),
    [prefs.scopes]
  );

  return {
    supported,
    permission,
    subscription,
    isSubscribed: Boolean(subscription),
    prefs,
    placeScopes,
    customScopes,
    setPrefs,
    isLoading,
    isSaving,
    isSendingTest,
    error,
    notice,
    subscribe,
    unsubscribe,
    savePreferences,
    sendTestNotification,
    addScope,
    removeScope,
    placeHasCountyData
  };
}
