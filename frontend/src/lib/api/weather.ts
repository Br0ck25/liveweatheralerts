import type { WeatherPayload } from "../../types";
import { requestJson } from "./http";

type WeatherQuery = {
  lat: number;
  lon: number;
};

function parseGeneratedAt(payload: WeatherPayload): string {
  return (
    payload.meta?.generatedAt ||
    payload.generatedAt ||
    payload.updated ||
    new Date().toISOString()
  );
}

export async function getWeather(
  query?: WeatherQuery,
  signal?: AbortSignal
): Promise<WeatherPayload> {
  const search = query
    ? `?lat=${encodeURIComponent(String(query.lat))}&lon=${encodeURIComponent(
        String(query.lon)
      )}`
    : "";
  const payload = await requestJson<WeatherPayload>(`/api/weather${search}`, {
    signal,
    fallbackError: "Forecast is unavailable right now."
  });

  return {
    ...payload,
    meta: {
      generatedAt: parseGeneratedAt(payload)
    }
  };
}
