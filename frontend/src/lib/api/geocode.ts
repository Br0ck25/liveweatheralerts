import type { GeocodeLocationPayload } from "../../types";
import { requestJson } from "./http";

function parseGeocode(payload: GeocodeLocationPayload): GeocodeLocationPayload {
  return {
    city: typeof payload.city === "string" ? payload.city : undefined,
    state: typeof payload.state === "string" ? payload.state : undefined,
    label: typeof payload.label === "string" ? payload.label : undefined,
    county: typeof payload.county === "string" ? payload.county : undefined,
    countyCode:
      typeof payload.countyCode === "string" ? payload.countyCode : undefined,
    lat: Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : undefined,
    lon: Number.isFinite(Number(payload.lon)) ? Number(payload.lon) : undefined
  };
}

export async function geocodeByZip(
  zip: string,
  signal?: AbortSignal
): Promise<GeocodeLocationPayload> {
  const payload = await requestJson<GeocodeLocationPayload>(
    `/api/geocode?zip=${encodeURIComponent(zip)}`,
    {
      signal,
      fallbackError: "ZIP code lookup failed."
    }
  );
  return parseGeocode(payload);
}

export async function geocodeByQuery(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeLocationPayload> {
  const payload = await requestJson<GeocodeLocationPayload>(
    `/api/geocode?query=${encodeURIComponent(query)}`,
    {
      signal,
      fallbackError: "Location lookup failed."
    }
  );
  return parseGeocode(payload);
}
