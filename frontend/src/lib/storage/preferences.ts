const ALERTS_LAST_SEEN_AT_KEY = "lwa:alerts:last-seen-at:v1";
const ALERTS_LAST_SEEN_BY_PLACE_KEY = "lwa:alerts:last-seen-by-place:v1";

function isValidIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

export function readAlertsLastSeenAt(placeId?: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    const scopedPlaceId = String(placeId || "").trim();
    if (scopedPlaceId) {
      const scopedRaw = window.localStorage.getItem(ALERTS_LAST_SEEN_BY_PLACE_KEY);
      if (scopedRaw) {
        const parsed = JSON.parse(scopedRaw) as Record<string, unknown>;
        const scopedValue = String(parsed?.[scopedPlaceId] || "").trim();
        if (scopedValue && isValidIsoTimestamp(scopedValue)) {
          return scopedValue;
        }
      }
    }

    const raw = window.localStorage.getItem(ALERTS_LAST_SEEN_AT_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || !isValidIsoTimestamp(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function writeAlertsLastSeenAt(value: string, placeId?: string): void {
  if (typeof window === "undefined") return;
  if (!isValidIsoTimestamp(value)) return;

  try {
    window.localStorage.setItem(ALERTS_LAST_SEEN_AT_KEY, value);
    const scopedPlaceId = String(placeId || "").trim();
    if (scopedPlaceId) {
      const rawMap = window.localStorage.getItem(ALERTS_LAST_SEEN_BY_PLACE_KEY);
      const parsedMap =
        rawMap && rawMap.trim()
          ? (JSON.parse(rawMap) as Record<string, unknown>)
          : {};
      parsedMap[scopedPlaceId] = value;
      window.localStorage.setItem(
        ALERTS_LAST_SEEN_BY_PLACE_KEY,
        JSON.stringify(parsedMap)
      );
    }
  } catch {
    // Ignore localStorage failures in restricted contexts.
  }
}
