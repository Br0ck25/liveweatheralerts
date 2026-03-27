import type { SavedLocationPreference, SavedPlace } from "../../types";
import {
  clearSavedLocationPreference,
  normalizeCountyCode,
  readSavedLocationPreference,
  saveLocationPreference,
  toStateCode
} from "./location";

export const PLACES_STORAGE_KEY = "lwa:places:v1";
export const PLACE_LABEL_PRESETS = ["Home", "Work", "Family", "Travel"] as const;
export type PlaceLabelPreset = (typeof PLACE_LABEL_PRESETS)[number] | "Custom";

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

export function createPlaceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `place-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeSavedPlace(
  value: Partial<SavedPlace> & Record<string, unknown>,
  nowIso: string
): SavedPlace | null {
  const stateCode = toStateCode(String(value.stateCode || ""));
  if (!stateCode) return null;

  const id = String(value.id || "").trim() || createPlaceId();
  const label = String(value.label || "").trim() || stateCode;
  const rawInput = String(value.rawInput || "").trim() || label;
  const countyName = String(value.countyName || "").trim() || undefined;
  const countyCode = normalizeCountyCode(String(value.countyCode || ""));
  const createdAt = toIsoTimestamp(value.createdAt, nowIso);
  const updatedAt = toIsoTimestamp(value.updatedAt, createdAt);

  return {
    id,
    label,
    rawInput,
    stateCode,
    countyName,
    countyCode: countyCode || undefined,
    lat: toFiniteNumber(value.lat),
    lon: toFiniteNumber(value.lon),
    isPrimary: value.isPrimary === true,
    createdAt,
    updatedAt
  };
}

function normalizeSavedPlaces(rawPlaces: unknown): SavedPlace[] {
  const nowIso = new Date().toISOString();
  if (!Array.isArray(rawPlaces)) return [];

  const parsed = rawPlaces
    .map((item) => normalizeSavedPlace(item as Partial<SavedPlace> & Record<string, unknown>, nowIso))
    .filter((item): item is SavedPlace => Boolean(item));
  if (parsed.length === 0) return [];

  const firstPrimaryIndex = parsed.findIndex((place) => place.isPrimary);
  const primaryIndex = firstPrimaryIndex >= 0 ? firstPrimaryIndex : 0;
  return parsed.map((place, index) => ({
    ...place,
    isPrimary: index === primaryIndex
  }));
}

function legacyPreferenceToPlace(
  preference: SavedLocationPreference,
  nowIso = new Date().toISOString()
): SavedPlace {
  const savedAt = String(preference.savedAt || "").trim();
  const createdAt = toIsoTimestamp(savedAt, nowIso);
  return {
    id: createPlaceId(),
    label: String(preference.label || preference.stateCode).trim() || preference.stateCode,
    rawInput:
      String(preference.rawInput || preference.label || preference.stateCode).trim() ||
      preference.stateCode,
    stateCode: preference.stateCode,
    countyName: preference.countyName,
    countyCode: preference.countyCode ? normalizeCountyCode(preference.countyCode) : undefined,
    lat: toFiniteNumber(preference.lat),
    lon: toFiniteNumber(preference.lon),
    isPrimary: true,
    createdAt,
    updatedAt: createdAt
  };
}

function syncLegacyLocationPreference(places: SavedPlace[]): void {
  if (typeof window === "undefined") return;

  const primary = places.find((place) => place.isPrimary) ?? places[0];
  if (!primary) {
    clearSavedLocationPreference();
    return;
  }

  saveLocationPreference({
    stateCode: primary.stateCode,
    rawInput: primary.rawInput,
    label: primary.label,
    countyName: primary.countyName,
    countyCode: primary.countyCode,
    lat: primary.lat,
    lon: primary.lon,
    savedAt: primary.updatedAt
  });
}

export function writeSavedPlaces(places: SavedPlace[]): SavedPlace[] {
  if (typeof window === "undefined") return normalizeSavedPlaces(places);

  const normalized = normalizeSavedPlaces(places);
  try {
    if (normalized.length > 0) {
      window.localStorage.setItem(PLACES_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(PLACES_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage failures.
  }

  syncLegacyLocationPreference(normalized);
  return normalized;
}

export function readSavedPlaces(): SavedPlace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PLACES_STORAGE_KEY);
    if (raw) {
      const parsed = normalizeSavedPlaces(JSON.parse(raw));
      if (parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Fallback to legacy migration below.
  }

  const legacyPreference = readSavedLocationPreference();
  if (!legacyPreference) return [];

  const migratedPlaces = [legacyPreferenceToPlace(legacyPreference)];
  return writeSavedPlaces(migratedPlaces);
}

export function readPrimarySavedPlace(): SavedPlace | null {
  const places = readSavedPlaces();
  return places.find((place) => place.isPrimary) ?? places[0] ?? null;
}

export function upsertSavedPlace(
  places: SavedPlace[],
  place: Omit<SavedPlace, "createdAt" | "updatedAt"> & Partial<Pick<SavedPlace, "createdAt" | "updatedAt">>
): SavedPlace[] {
  const nowIso = new Date().toISOString();
  const next: SavedPlace = {
    ...place,
    countyCode: place.countyCode ? normalizeCountyCode(place.countyCode) : undefined,
    createdAt: toIsoTimestamp(place.createdAt, nowIso),
    updatedAt: toIsoTimestamp(place.updatedAt, nowIso)
  };

  const existingIndex = places.findIndex((item) => item.id === place.id);
  if (existingIndex >= 0) {
    const merged = [...places];
    merged[existingIndex] = {
      ...merged[existingIndex],
      ...next,
      updatedAt: nowIso
    };
    return normalizeSavedPlaces(merged);
  }

  const withDefaults: SavedPlace = {
    ...next,
    isPrimary: places.length === 0 ? true : next.isPrimary
  };
  return normalizeSavedPlaces([...places, withDefaults]);
}

export function removeSavedPlaceById(places: SavedPlace[], placeId: string): SavedPlace[] {
  return normalizeSavedPlaces(places.filter((place) => place.id !== placeId));
}

export function setPrimarySavedPlace(places: SavedPlace[], placeId: string): SavedPlace[] {
  const nowIso = new Date().toISOString();
  const hasTarget = places.some((place) => place.id === placeId);
  if (!hasTarget) return normalizeSavedPlaces(places);
  return normalizeSavedPlaces(
    places.map((place) => ({
      ...place,
      isPrimary: place.id === placeId,
      updatedAt: place.id === placeId ? nowIso : place.updatedAt
    }))
  );
}

export function createSavedPlaceFromResolvedLocation(input: {
  id?: string;
  label: string;
  rawInput: string;
  stateCode: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
  isPrimary?: boolean;
}): SavedPlace {
  const nowIso = new Date().toISOString();
  return {
    id: input.id || createPlaceId(),
    label: input.label.trim() || input.stateCode.trim().toUpperCase(),
    rawInput: input.rawInput.trim() || input.label.trim() || input.stateCode.trim().toUpperCase(),
    stateCode: input.stateCode.trim().toUpperCase(),
    countyName: input.countyName?.trim() || undefined,
    countyCode: input.countyCode ? normalizeCountyCode(input.countyCode) || undefined : undefined,
    lat: toFiniteNumber(input.lat),
    lon: toFiniteNumber(input.lon),
    isPrimary: input.isPrimary === true,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}
