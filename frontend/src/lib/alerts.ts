import type { AlertsPayload } from "../types";
import { getAlerts } from "./api/alerts";
import { buildApiUrl, getApiBase } from "./api/http";

export { buildApiUrl, getApiBase };

export async function fetchAlerts(signal?: AbortSignal): Promise<AlertsPayload> {
  return await getAlerts(signal);
}
