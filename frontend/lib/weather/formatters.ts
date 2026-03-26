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
    size === "current" ? "h-16 w-16" : "h-7 w-7";

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
