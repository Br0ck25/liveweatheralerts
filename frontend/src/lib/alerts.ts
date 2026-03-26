import type { AlertsPayload } from "../types";

export function getApiBase(): string {
  const configured = (import.meta.env.VITE_ALERTS_API_BASE ?? "").trim();
  if (!configured) return "";
  return configured.replace(/\/+$/, "");
}

export function buildApiUrl(path: string): string {
  const base = getApiBase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export async function fetchAlerts(signal?: AbortSignal): Promise<AlertsPayload> {
  const endpoint = buildApiUrl("/api/alerts");

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`Unable to load alerts (${response.status}).`);
  }

  const payload = (await response.json()) as AlertsPayload;
  if (!payload || !Array.isArray(payload.alerts)) {
    throw new Error("Unexpected alert payload received from API.");
  }

  return payload;
}
