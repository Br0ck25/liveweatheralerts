import { useMemo, useRef } from "react";
import type { AlertRecord, AlertsMeta, WeatherDailyPeriod, WeatherPayload } from "../../../types";
import { ImpactCard } from "../../alerts/components/ImpactCard";
import { buildImpactCardsForAlert, formatDateTime } from "../../alerts/utils";

type ForecastLoadState = "idle" | "loading" | "ready" | "error";

type ForecastPageProps = {
  isOffline: boolean;
  alertsMeta: AlertsMeta | null;
  forecastLoadState: ForecastLoadState;
  forecastData: WeatherPayload | null;
  forecastError: string | null;
  forecastLocation: string;
  currentCondition: string;
  currentIsNight: boolean;
  todayForecast: WeatherDailyPeriod | undefined;
  hourlyForecast: WeatherPayload["hourly"];
  dailyForecast: WeatherPayload["daily"];
  selectedForecastDayIndex: number;
  selectedForecastDay: WeatherDailyPeriod | undefined;
  selectedForecastAlerts: AlertRecord[];
  forecastAlertsByDay: AlertRecord[][];
  onSelectForecastDay: (index: number) => void;
  onOpenAlertFromForecast: (alert: AlertRecord) => void;
};

function formatTemp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${Math.round(value)}°`;
}

function formatMph(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return `${Math.round(value)} mph`;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatHourLabel(value: string | undefined, index: number): string {
  if (index === 0) return "Now";
  const date = toDate(value);
  if (!date) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric"
  }).format(date);
}

function formatDayLabel(value: string | undefined): string {
  const date = toDate(value);
  if (!date) return "Day";
  const now = new Date();
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return "Today";
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short"
  }).format(date);
}

function formatMonthDay(value: string | undefined): string {
  const date = toDate(value);
  if (!date) return "--";
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric"
  }).format(date);
}

function formatLongDay(value: string | undefined): string {
  const date = toDate(value);
  if (!date) return "Selected day";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(date);
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "\u00A0";
  return `${Math.round(value)}%`;
}

type ForecastIconKind =
  | "sun"
  | "moon"
  | "cloud"
  | "partly-day"
  | "partly-night"
  | "rain"
  | "storm"
  | "snow"
  | "fog"
  | "wind";

function inferNightFromStartTime(value: string | undefined): boolean {
  const date = toDate(value);
  if (!date) return false;
  const hour = date.getHours();
  return hour < 6 || hour >= 18;
}

function inferNightFromCondition(value: string | undefined): boolean {
  const text = String(value || "").toLowerCase();
  return /(night|overnight|tonight|evening|late)/.test(text);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function resolveForecastIconKind(
  condition: string | undefined,
  isNight: boolean
): ForecastIconKind {
  const text = String(condition || "").toLowerCase();
  if (/(thunder|t-?storm|lightning)/.test(text)) return "storm";
  if (/(snow|flurr|sleet|blizzard|ice pellets|freezing drizzle)/.test(text)) {
    return "snow";
  }
  if (/(rain|showers|drizzle|sprinkles|downpour)/.test(text)) return "rain";
  if (/(fog|haze|mist|smoke)/.test(text)) return "fog";
  if (/(wind|breezy|gust)/.test(text) && !/(rain|snow|storm)/.test(text)) {
    return "wind";
  }

  const partly =
    /(partly|mostly|few|scattered|broken)/.test(text) &&
    /(cloud|sun|clear)/.test(text);
  if (partly) return isNight ? "partly-night" : "partly-day";

  if (/(cloud|overcast)/.test(text)) return "cloud";
  if (/(clear|fair|sunny)/.test(text)) return isNight ? "moon" : "sun";

  return isNight ? "partly-night" : "partly-day";
}

function WeatherIcon({
  condition,
  isNight,
  className
}: {
  condition?: string;
  isNight: boolean;
  className?: string;
}) {
  const kind = resolveForecastIconKind(condition, isNight);
  const classes = `weather-symbol${className ? ` ${className}` : ""}`;

  if (kind === "sun") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="13" fill="#f7b500" stroke="#e06a00" strokeWidth="3" />
        <g stroke="#f4a100" strokeWidth="3" strokeLinecap="round">
          <line x1="32" y1="6" x2="32" y2="14" />
          <line x1="32" y1="50" x2="32" y2="58" />
          <line x1="6" y1="32" x2="14" y2="32" />
          <line x1="50" y1="32" x2="58" y2="32" />
          <line x1="14" y1="14" x2="19" y2="19" />
          <line x1="45" y1="45" x2="50" y2="50" />
          <line x1="14" y1="50" x2="19" y2="45" />
          <line x1="45" y1="19" x2="50" y2="14" />
        </g>
      </svg>
    );
  }

  if (kind === "moon") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="30" cy="32" r="15" fill="#2f66dd" />
        <circle cx="38" cy="26" r="14" fill="#f8fbff" />
      </svg>
    );
  }

  if (kind === "partly-day" || kind === "partly-night") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        {kind === "partly-day" ? (
          <>
            <circle cx="23" cy="24" r="11" fill="#f7b500" stroke="#e06a00" strokeWidth="3" />
          </>
        ) : (
          <>
            <circle cx="24" cy="25" r="11" fill="#2f66dd" />
            <circle cx="30" cy="21" r="10" fill="#f8fbff" />
          </>
        )}
        <path
          d="M14 40c0-5.2 4.2-9.4 9.4-9.4 1.5 0 3 .4 4.2 1.1 1.8-3.4 5.3-5.8 9.5-5.8 6 0 10.9 4.8 10.9 10.9 0 .4 0 .8-.1 1.2 3.2.8 5.5 3.7 5.5 7.2 0 4.1-3.3 7.4-7.4 7.4H22.1c-4.5 0-8.1-3.6-8.1-8.1 0-1.8.6-3.3 1.6-4.5z"
          fill="#edf2f7"
          stroke="#6f7f95"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (kind === "rain") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <path
          d="M14 35.5c0-5 4.1-9.1 9.1-9.1 1.5 0 2.9.3 4.2 1 1.8-3.3 5.2-5.5 9.2-5.5 5.9 0 10.7 4.7 10.7 10.6v.9c3.3.7 5.8 3.7 5.8 7.3 0 4.1-3.3 7.4-7.4 7.4H22c-4.4 0-8-3.6-8-8 0-1.8.6-3.4 1.8-4.6z"
          fill="#eef3f8"
          stroke="#71849c"
          strokeWidth="3"
        />
        <g fill="#2f7be8">
          <circle cx="25" cy="54" r="2.4" />
          <circle cx="34" cy="57" r="2.4" />
          <circle cx="43" cy="54" r="2.4" />
        </g>
      </svg>
    );
  }

  if (kind === "storm") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <path
          d="M14 35.5c0-5 4.1-9.1 9.1-9.1 1.5 0 2.9.3 4.2 1 1.8-3.3 5.2-5.5 9.2-5.5 5.9 0 10.7 4.7 10.7 10.6v.9c3.3.7 5.8 3.7 5.8 7.3 0 4.1-3.3 7.4-7.4 7.4H22c-4.4 0-8-3.6-8-8 0-1.8.6-3.4 1.8-4.6z"
          fill="#e9eef6"
          stroke="#6f819a"
          strokeWidth="3"
        />
        <path
          d="M33 48l-5 9h4l-3 7 10-12h-4l4-8z"
          fill="#f6b600"
          stroke="#d97f00"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (kind === "snow") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <path
          d="M14 35.5c0-5 4.1-9.1 9.1-9.1 1.5 0 2.9.3 4.2 1 1.8-3.3 5.2-5.5 9.2-5.5 5.9 0 10.7 4.7 10.7 10.6v.9c3.3.7 5.8 3.7 5.8 7.3 0 4.1-3.3 7.4-7.4 7.4H22c-4.4 0-8-3.6-8-8 0-1.8.6-3.4 1.8-4.6z"
          fill="#eef3f8"
          stroke="#71849c"
          strokeWidth="3"
        />
        <g stroke="#4f8ee8" strokeWidth="2" strokeLinecap="round">
          <line x1="25" y1="53" x2="25" y2="58" />
          <line x1="22.5" y1="55.5" x2="27.5" y2="55.5" />
          <line x1="34" y1="52" x2="34" y2="57" />
          <line x1="31.5" y1="54.5" x2="36.5" y2="54.5" />
          <line x1="43" y1="53" x2="43" y2="58" />
          <line x1="40.5" y1="55.5" x2="45.5" y2="55.5" />
        </g>
      </svg>
    );
  }

  if (kind === "fog") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <path
          d="M14 34.5c0-5 4.1-9.1 9.1-9.1 1.5 0 2.9.3 4.2 1 1.8-3.3 5.2-5.5 9.2-5.5 5.9 0 10.7 4.7 10.7 10.6v.9c3.3.7 5.8 3.7 5.8 7.3 0 4.1-3.3 7.4-7.4 7.4H22c-4.4 0-8-3.6-8-8 0-1.8.6-3.4 1.8-4.6z"
          fill="#eef3f8"
          stroke="#71849c"
          strokeWidth="3"
        />
        <g stroke="#8a99ad" strokeWidth="2.5" strokeLinecap="round">
          <line x1="17" y1="53" x2="49" y2="53" />
          <line x1="21" y1="58" x2="45" y2="58" />
        </g>
      </svg>
    );
  }

  if (kind === "wind") {
    return (
      <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
        <g fill="none" stroke="#4f79a6" strokeWidth="3.2" strokeLinecap="round">
          <path d="M12 26h26c4 0 6-2.8 6-5.8 0-2.9-2-5.3-5.2-5.3-3 0-5.1 2.1-5.1 4.8" />
          <path d="M12 35h34c3.6 0 6.4 2.6 6.4 5.9 0 3.1-2.4 5.6-5.4 5.6-2.8 0-4.9-1.9-4.9-4.5" />
          <path d="M12 45h17" />
        </g>
      </svg>
    );
  }

  return (
    <svg className={classes} viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M14 35.5c0-5 4.1-9.1 9.1-9.1 1.5 0 2.9.3 4.2 1 1.8-3.3 5.2-5.5 9.2-5.5 5.9 0 10.7 4.7 10.7 10.6v.9c3.3.7 5.8 3.7 5.8 7.3 0 4.1-3.3 7.4-7.4 7.4H22c-4.4 0-8-3.6-8-8 0-1.8.6-3.4 1.8-4.6z"
        fill="#edf2f7"
        stroke="#6f7f95"
        strokeWidth="3"
      />
    </svg>
  );
}

export function ForecastPage({
  isOffline,
  alertsMeta,
  forecastLoadState,
  forecastData,
  forecastError,
  forecastLocation,
  currentCondition,
  currentIsNight,
  todayForecast,
  hourlyForecast,
  dailyForecast,
  selectedForecastDayIndex,
  selectedForecastDay,
  selectedForecastAlerts,
  forecastAlertsByDay,
  onSelectForecastDay,
  onOpenAlertFromForecast
}: ForecastPageProps) {
  const hourlyStripRef = useRef<HTMLDivElement | null>(null);
  const dailyStripRef = useRef<HTMLDivElement | null>(null);
  const selectedDayImpactCards = useMemo(() => {
    if (!selectedForecastDay || selectedForecastAlerts.length === 0) return [];

    const forecastContext = {
      dayLabel: formatLongDay(selectedForecastDay.startTime),
      precipitationChance: selectedForecastDay.precipitationChance ?? null,
      windMph: forecastData?.current?.windMph ?? null,
      highF: selectedForecastDay.highF ?? null,
      lowF: selectedForecastDay.lowF ?? null,
      daySummary: selectedForecastDay.shortForecast ?? "",
      nightSummary: selectedForecastDay.nightShortForecast ?? ""
    };

    const seen = new Set<string>();
    const cards: ReturnType<typeof buildImpactCardsForAlert> = [];

    for (const alert of selectedForecastAlerts) {
      const nextCards = buildImpactCardsForAlert(alert, {
        maxCards: 2,
        forecastContext
      });
      for (const card of nextCards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        cards.push(card);
        if (cards.length >= 4) return cards;
      }
    }

    return cards;
  }, [forecastData?.current?.windMph, selectedForecastAlerts, selectedForecastDay]);

  const scrollForecastStrip = (
    ref: { current: HTMLDivElement | null },
    direction: "left" | "right"
  ) => {
    const target = ref.current;
    if (!target) return;
    const amount = Math.max(220, Math.round(target.clientWidth * 0.72));
    target.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: prefersReducedMotion() ? "auto" : "smooth"
    });
  };

  return (
    <section className="forecast-panel">
      {isOffline ? (
        <section className="message offline-message" role="status">
          You are offline. Showing cached forecast data when available. Reconnect to
          refresh the next-hour and 7-day outlook.
        </section>
      ) : null}

      {alertsMeta?.stale ? (
        <section className="message warning-message" role="status">
          Alerts sync appears stale ({alertsMeta.staleMinutes} minutes old), so
          forecast-linked alert context may lag.
        </section>
      ) : null}

      <article className="forecast-hero">
        <div className="forecast-cloud cloud-one" />
        <div className="forecast-cloud cloud-two" />
        <div className="forecast-mountain mountain-one" />
        <div className="forecast-mountain mountain-two" />
        <p className="forecast-location">{forecastLocation}</p>
        <div className="forecast-condition-row">
          <WeatherIcon
            className="forecast-hero-icon"
            condition={currentCondition}
            isNight={currentIsNight}
          />
          <p>{currentCondition}</p>
        </div>
        <p className="forecast-hero-temp">
          {formatTemp(forecastData?.current?.temperatureF)}
        </p>
        <p className="forecast-hero-detail">
          Feels like {formatTemp(forecastData?.current?.feelsLikeF)}
        </p>
        <p className="forecast-hero-detail forecast-hero-detail-contrast">
          High {formatTemp(todayForecast?.highF)} • Low {formatTemp(todayForecast?.lowF)}
        </p>
      </article>

      {forecastLoadState === "loading" ? (
        <div className="skeleton-grid">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      ) : null}

      {forecastError ? (
        <section className="message error-message" role="alert">
          <strong>Could not load forecast:</strong> {forecastError}
        </section>
      ) : null}

      {forecastLoadState === "ready" && forecastData ? (
        <>
          <article className="forecast-block">
            <header className="forecast-block-head">
              <h3>
                <span className="forecast-head-icon" aria-hidden="true">
                  ◷
                </span>
                Hourly forecast
              </h3>
              <div className="forecast-scroll-controls">
                <button
                  type="button"
                  className="forecast-scroll-btn"
                  aria-label="Scroll hourly forecast left"
                  onClick={() => scrollForecastStrip(hourlyStripRef, "left")}
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="forecast-scroll-btn"
                  aria-label="Scroll hourly forecast right"
                  onClick={() => scrollForecastStrip(hourlyStripRef, "right")}
                >
                  ▶
                </button>
              </div>
            </header>

            <div className="forecast-hourly-strip" ref={hourlyStripRef}>
              {(hourlyForecast ?? []).map((hour, index) => (
                <article
                  key={`${hour.startTime || "hour"}-${index}`}
                  className="forecast-hour-item"
                >
                  <p className="forecast-hour-temp">{formatTemp(hour.temperatureF)}</p>
                  <WeatherIcon
                    className="forecast-hour-icon"
                    condition={hour.shortForecast}
                    isNight={
                      inferNightFromStartTime(hour.startTime) ||
                      inferNightFromCondition(hour.shortForecast)
                    }
                  />
                  <p className="forecast-hour-precip">
                    {formatPercent(hour.precipitationChance)}
                  </p>
                  <p className="forecast-hour-label">
                    {formatHourLabel(hour.startTime, index)}
                  </p>
                </article>
              ))}
            </div>
          </article>

          <article className="forecast-block">
            <header className="forecast-block-head">
              <h3>
                <span className="forecast-head-icon" aria-hidden="true">
                  ▣
                </span>
                7-day forecast
              </h3>
              <div className="forecast-scroll-controls">
                <button
                  type="button"
                  className="forecast-scroll-btn"
                  aria-label="Scroll 7-day forecast left"
                  onClick={() => scrollForecastStrip(dailyStripRef, "left")}
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="forecast-scroll-btn"
                  aria-label="Scroll 7-day forecast right"
                  onClick={() => scrollForecastStrip(dailyStripRef, "right")}
                >
                  ▶
                </button>
              </div>
            </header>

            <div className="forecast-daily-strip" ref={dailyStripRef}>
              {(dailyForecast ?? []).map((day, index) => {
                const dayAlerts = forecastAlertsByDay[index] ?? [];
                const isSelected = index === selectedForecastDayIndex;
                const dayName = formatDayLabel(day.startTime);
                const dayDate = formatMonthDay(day.startTime);
                const alertCount = dayAlerts.length;
                return (
                  <button
                    type="button"
                    key={`${day.name || "day"}-${index}`}
                    className={`forecast-day-pill${isSelected ? " selected" : ""}`}
                    onClick={() => onSelectForecastDay(index)}
                    aria-pressed={isSelected}
                    aria-label={`${dayName} ${dayDate}${
                      alertCount ? `, ${alertCount} alert${alertCount === 1 ? "" : "s"}` : ""
                    }`}
                  >
                    {alertCount ? (
                      <span className="forecast-day-alert-pill" aria-hidden="true">
                        {alertCount}
                      </span>
                    ) : null}
                    <p className="forecast-day-high">{formatTemp(day.highF)}</p>
                    <p className="forecast-day-low">{formatTemp(day.lowF)}</p>
                    <WeatherIcon
                      className="forecast-day-icon"
                      condition={day.shortForecast}
                      isNight={false}
                    />
                    <p className="forecast-day-precip">
                      {formatPercent(day.precipitationChance)}
                    </p>
                    <p className="forecast-day-title">{dayName}</p>
                    <p className="forecast-day-date">{dayDate}</p>
                  </button>
                );
              })}
            </div>

            {selectedForecastDay ? (
              <section className="forecast-day-details">
                {(() => {
                  const daySummary =
                    selectedForecastDay.shortForecast?.trim() || "Day forecast";
                  const dayDetails =
                    selectedForecastDay.detailedForecast?.trim() ||
                    selectedForecastDay.shortForecast ||
                    "No daytime forecast details available.";
                  const nightSummary =
                    selectedForecastDay.nightShortForecast?.trim() ||
                    selectedForecastDay.nightName?.trim() ||
                    "";
                  const nightDetails =
                    selectedForecastDay.nightDetailedForecast?.trim() || "";
                  const showNight = Boolean(nightSummary || nightDetails);

                  return (
                    <>
                      <header>
                        <h4>{formatLongDay(selectedForecastDay.startTime)}</h4>
                      </header>

                      <section className="forecast-day-period">
                        <p className="forecast-day-period-label">Day</p>
                        <p className="forecast-day-period-summary">{daySummary}</p>
                        <p className="forecast-day-details-text">{dayDetails}</p>
                      </section>

                      {showNight ? (
                        <section className="forecast-day-period forecast-day-period-night">
                          <p className="forecast-day-period-label">Night</p>
                          <p className="forecast-day-period-summary">
                            {nightSummary || "Night forecast"}
                          </p>
                          <p className="forecast-day-details-text">
                            {nightDetails || "No overnight details available."}
                          </p>
                        </section>
                      ) : null}
                    </>
                  );
                })()}

                {selectedForecastAlerts.length ? (
                  <div className="forecast-day-alerts">
                    <p className="forecast-day-alerts-title">Alerts for this day</p>
                    {selectedDayImpactCards.length > 0 ? (
                      <div className="impact-card-grid impact-card-grid-forecast">
                        {selectedDayImpactCards.map((card) => (
                          <ImpactCard
                            key={card.id}
                            card={card}
                            className="impact-card-compact"
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="forecast-day-alert-links">
                      {selectedForecastAlerts.map((alert) => (
                        <button
                          key={alert.id}
                          type="button"
                          className="forecast-day-alert-link"
                          onClick={() => onOpenAlertFromForecast(alert)}
                        >
                          {alert.event} - View full alert details
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="forecast-day-no-alerts">
                    No active alerts mapped to this day.
                  </p>
                )}
              </section>
            ) : null}
          </article>

          {forecastData.updated ? (
            <p className="forecast-updated">
              Updated: {formatDateTime(forecastData.updated)}
            </p>
          ) : null}
          <p className="forecast-updated">
            Wind {formatMph(forecastData.current?.windMph)}{" "}
            {forecastData.current?.windDirection || ""}
          </p>
        </>
      ) : null}
    </section>
  );
}
