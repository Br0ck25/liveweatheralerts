export type AnalyticsEventName =
  | "alert_detail_viewed"
  | "alert_detail_shared"
  | "alert_detail_link_copied"
  | "alert_detail_safety_copied"
  | "alert_detail_radar_clicked";

export function trackEvent(
  name: AnalyticsEventName,
  payload: Record<string, unknown> = {}
): void {
  if (typeof window === "undefined") return;

  try {
    window.dispatchEvent(
      new CustomEvent("live-weather:analytics", {
        detail: {
          name,
          payload,
          timestamp: new Date().toISOString()
        }
      })
    );
  } catch {
    // Intentionally no-op: analytics must never break the alert UX.
  }
}
