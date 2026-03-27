import type { RadarPayload } from "../../types";
import { requestJson } from "./http";

type RadarQuery = {
  lat: number;
  lon: number;
};

function parseGeneratedAt(payload: RadarPayload): string {
  return (
    payload.meta?.generatedAt ||
    payload.generatedAt ||
    payload.updated ||
    new Date().toISOString()
  );
}

export async function getRadar(
  query: RadarQuery,
  signal?: AbortSignal
): Promise<RadarPayload> {
  const search = `?lat=${encodeURIComponent(
    String(query.lat)
  )}&lon=${encodeURIComponent(String(query.lon))}`;
  const payload = await requestJson<RadarPayload>(`/api/radar${search}`, {
    signal,
    fallbackError: "Radar is unavailable right now."
  });

  return {
    ...payload,
    meta: {
      generatedAt: parseGeneratedAt(payload)
    }
  };
}
