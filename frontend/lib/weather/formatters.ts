import { Cloud, CloudRain, Moon, Sun } from "lucide-react";
import { createElement, ReactNode } from "react";

export function formatTime(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatRelative(value?: string | null) {
  if (!value) return "just now";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "recently";
  const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 min ago";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hr ago`;
}

export function formatLiveTime(iso?: string | null) {
  if (!iso) return "Live";

  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "Live";

  const diffSec = Math.floor((Date.now() - ts) / 1000);

  if (diffSec < 10) return "Live • Updating";
  if (diffSec < 60) return "Live • Just now";

  const diffMin = Math.floor(diffSec / 60);

  if (diffMin < 5) return "Updated just now";
  if (diffMin < 15) return `Updated ${diffMin}m ago`;

  return "Live • Updating";
}

export function mapIcon(forecast = "") {
  const f = forecast.toLowerCase();

  if (f.includes("storm") || f.includes("thunder")) return "storm";
  if (f.includes("sun") || f.includes("clear")) return "sun";
  if (f.includes("night")) return "night";
  if (f.includes("cloud")) return "cloud";

  return "cloud";
}

export type WeatherIconType = "storm" | "sun" | "cloud" | "night";

export function iconForHourly(
  icon: WeatherIconType,
  size: "hourly" | "current" = "hourly"
): ReactNode {
  const className =
    size === "current" ? "h-20 w-20" : "h-7 w-7";

  if (icon === "storm") {
    return createElement(CloudRain, { className: `${className} text-sky-300` });
  }

  if (icon === "sun") {
    return createElement(Sun, { className: `${className} text-yellow-300` });
  }

  if (icon === "night") {
    return createElement(Moon, { className: `${className} text-blue-200` });
  }

  if (icon === "cloud") {
    return createElement(Cloud, { className: `${className} text-slate-200` });
  }

  return createElement(Cloud, { className: `${className} text-slate-200` });
}

export function isNightForHour(
  startTime?: string | null,
  sunrise?: string | null,
  sunset?: string | null
) {
  const time = startTime ? Date.parse(startTime) : NaN;
  const rise = sunrise ? Date.parse(sunrise) : NaN;
  const set = sunset ? Date.parse(sunset) : NaN;

  if (Number.isFinite(time) && Number.isFinite(rise) && Number.isFinite(set)) {
    return time < rise || time >= set;
  }

  const d = startTime ? new Date(startTime) : new Date();
  const hour = d.getHours();
  return hour < 6 || hour >= 18;
}

export function resolveWeatherIcon(
  forecast?: string | null,
  isNight?: boolean
): WeatherIconType {
  const text = String(forecast || "").toLowerCase();

  if (
    text.includes("thunder") ||
    text.includes("storm") ||
    text.includes("tornado") ||
    text.includes("lightning")
  ) {
    return "storm";
  }

  if (
    text.includes("rain") ||
    text.includes("shower") ||
    text.includes("drizzle") ||
    text.includes("snow") ||
    text.includes("sleet") ||
    text.includes("ice") ||
    text.includes("freezing") ||
    text.includes("fog") ||
    text.includes("mist") ||
    text.includes("haze") ||
    text.includes("smoke") ||
    text.includes("overcast") ||
    text.includes("mostly cloudy") ||
    text.includes("partly cloudy") ||
    text.includes("cloud")
  ) {
    return "cloud";
  }

  if (
    text.includes("clear") ||
    text.includes("sunny") ||
    text.includes("mostly sunny") ||
    text.includes("partly sunny")
  ) {
    return isNight ? "night" : "sun";
  }

  return isNight ? "night" : "sun";
}

export function formatAlertDate(value?: string) {
  if (!value) return "—";

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}):(\d{2})$/
  );

  if (!match) return value;

  const [, yearStr, monthStr, dayStr, hourStr, minute, offsetHour] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let hour = Number(hourStr);

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const weekday = weekdayNames[new Date(year, month - 1, day).getDay()];
  const monthName = monthNames[month - 1];

  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;

  return `${weekday}, ${monthName} ${day}, ${year}, ${hour}:${minute} ${ampm} (UTC${offsetHour})`;
}

export function formatTimeLeft(expires?: string, whenText?: string | null) {
  if (whenText && whenText.toLowerCase().includes("until further notice")) {
    return "Ongoing";
  }

  if (!expires) return "—";

  const diff = new Date(expires).getTime() - Date.now();
  if (diff <= 0) return "Expired";

  const totalMin = Math.floor(diff / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}
