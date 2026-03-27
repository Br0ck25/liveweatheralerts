import type { SavedLocationPreference } from "../../types";

export type AppTabPreference = "alerts" | "forecast" | "more";

export const LOCATION_STORAGE_KEY = "lwa:preferred-state:v1";
export const LOCATION_MODAL_DISMISSED_KEY = "lwa:location-modal-dismissed:v1";
export const ACTIVE_TAB_STORAGE_KEY = "lwa:active-tab:v1";

const STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "alabama",
  AK: "alaska",
  AZ: "arizona",
  AR: "arkansas",
  CA: "california",
  CO: "colorado",
  CT: "connecticut",
  DE: "delaware",
  FL: "florida",
  GA: "georgia",
  HI: "hawaii",
  ID: "idaho",
  IL: "illinois",
  IN: "indiana",
  IA: "iowa",
  KS: "kansas",
  KY: "kentucky",
  LA: "louisiana",
  ME: "maine",
  MD: "maryland",
  MA: "massachusetts",
  MI: "michigan",
  MN: "minnesota",
  MS: "mississippi",
  MO: "missouri",
  MT: "montana",
  NE: "nebraska",
  NV: "nevada",
  NH: "new hampshire",
  NJ: "new jersey",
  NM: "new mexico",
  NY: "new york",
  NC: "north carolina",
  ND: "north dakota",
  OH: "ohio",
  OK: "oklahoma",
  OR: "oregon",
  PA: "pennsylvania",
  RI: "rhode island",
  SC: "south carolina",
  SD: "south dakota",
  TN: "tennessee",
  TX: "texas",
  UT: "utah",
  VT: "vermont",
  VA: "virginia",
  WA: "washington",
  WV: "west virginia",
  WI: "wisconsin",
  WY: "wyoming",
  DC: "district of columbia"
};

const STATE_ALIAS_TO_CODE: Record<string, string> = Object.entries(
  STATE_NAME_BY_CODE
).reduce<Record<string, string>>(
  (accumulator, [code, name]) => {
    accumulator[code.toLowerCase()] = code;
    accumulator[name] = code;
    return accumulator;
  },
  {
    "washington dc": "DC",
    "washington d c": "DC",
    "district columbia": "DC"
  }
);

function cleanToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeCountyCode(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(3, "0").slice(-3);
}

export function toStateCode(value: string): string | null {
  const alias = cleanToken(value);
  if (!alias) return null;
  return STATE_ALIAS_TO_CODE[alias] ?? null;
}

export function resolveStateFromText(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  const direct = toStateCode(input);
  if (direct) return direct;

  const commaParts = input.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    const commaState = toStateCode(commaParts[commaParts.length - 1]);
    if (commaState) return commaState;
  }

  const words = input.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const lastWordState = toStateCode(words[words.length - 1]);
    if (lastWordState) return lastWordState;
  }

  if (words.length > 2) {
    const lastTwo = toStateCode(words.slice(-2).join(" "));
    if (lastTwo) return lastTwo;
  }

  return null;
}

export function isLikelyStateOnlyInput(value: string): boolean {
  const input = value.trim();
  if (!input || input.includes(",")) return false;
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  return toStateCode(input) !== null;
}

export function readSavedLocationPreference(): SavedLocationPreference | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLocationPreference> &
      Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const stateCode = toStateCode(String(parsed.stateCode || ""));
    if (!stateCode) return null;
    return {
      stateCode,
      rawInput: String(parsed.rawInput || stateCode),
      label: String(parsed.label || stateCode),
      countyName: parsed.countyName ? String(parsed.countyName) : undefined,
      countyCode: parsed.countyCode
        ? normalizeCountyCode(String(parsed.countyCode))
        : undefined,
      lat: toFiniteNumber(parsed.lat),
      lon: toFiniteNumber(parsed.lon),
      savedAt: String(parsed.savedAt || "")
    };
  } catch {
    return null;
  }
}

export function saveLocationPreference(preference: SavedLocationPreference): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(preference));
}

export function clearSavedLocationPreference(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOCATION_STORAGE_KEY);
  } catch {
    // Ignore localStorage failures.
  }
}

export function isLocationModalDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCATION_MODAL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLocationModalDismissed(dismissed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (dismissed) {
      window.localStorage.setItem(LOCATION_MODAL_DISMISSED_KEY, "1");
    } else {
      window.localStorage.removeItem(LOCATION_MODAL_DISMISSED_KEY);
    }
  } catch {
    // Ignore localStorage failures in private mode or restricted contexts.
  }
}

export function readSavedActiveTab(): AppTabPreference {
  if (typeof window === "undefined") return "alerts";
  try {
    const value = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (value === "alerts" || value === "forecast" || value === "more") {
      return value;
    }
  } catch {
    // Ignore localStorage failures.
  }
  return "alerts";
}

export function saveActiveTab(tab: AppTabPreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
  } catch {
    // Ignore localStorage failures.
  }
}

export function pathFromTab(tab: AppTabPreference): string {
  if (tab === "forecast") return "/forecast";
  if (tab === "more") return "/settings";
  return "/alerts";
}

export function tabFromPath(pathname: string): AppTabPreference {
  if (pathname.startsWith("/forecast")) return "forecast";
  if (pathname.startsWith("/settings")) return "more";
  return "alerts";
}

export function defaultRouteFromSavedTab(): string {
  return pathFromTab(readSavedActiveTab());
}
