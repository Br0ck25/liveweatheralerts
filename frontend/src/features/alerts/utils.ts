import type {
  AlertChangeRecord,
  AlertChangeType,
  AlertImpactCategory,
  AlertLifecycleStatus,
  AlertRecord,
  AlertType,
  SeverityFilter
} from "../../types";

const STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "alabama",
  AK: "alaska",
  AZ: "arizona",
  AR: "arkansas",
  CA: "california",
  CO: "colorado",
  CT: "connecticut",
  DE: "delaware",
  FL: "florida",
  GA: "georgia",
  HI: "hawaii",
  ID: "idaho",
  IL: "illinois",
  IN: "indiana",
  IA: "iowa",
  KS: "kansas",
  KY: "kentucky",
  LA: "louisiana",
  ME: "maine",
  MD: "maryland",
  MA: "massachusetts",
  MI: "michigan",
  MN: "minnesota",
  MS: "mississippi",
  MO: "missouri",
  MT: "montana",
  NE: "nebraska",
  NV: "nevada",
  NH: "new hampshire",
  NJ: "new jersey",
  NM: "new mexico",
  NY: "new york",
  NC: "north carolina",
  ND: "north dakota",
  OH: "ohio",
  OK: "oklahoma",
  OR: "oregon",
  PA: "pennsylvania",
  RI: "rhode island",
  SC: "south carolina",
  SD: "south dakota",
  TN: "tennessee",
  TX: "texas",
  UT: "utah",
  VT: "vermont",
  VA: "virginia",
  WA: "washington",
  WV: "west virginia",
  WI: "wisconsin",
  WY: "wyoming",
  DC: "district of columbia"
};

const severityWeight: Record<SeverityFilter, number> = {
  extreme: 100,
  severe: 80,
  moderate: 60,
  minor: 40,
  unknown: 20,
  all: 0
};

const urgencyWeight: Record<string, number> = {
  immediate: 30,
  expected: 20,
  future: 10,
  past: 2,
  unknown: 5
};

const certaintyWeight: Record<string, number> = {
  observed: 25,
  likely: 18,
  possible: 10,
  unlikely: 4,
  unknown: 6
};

const alertTypeWeight: Record<AlertType, number> = {
  warning: 100,
  watch: 75,
  advisory: 50,
  statement: 40,
  other: 30
};

const SECTION_LABEL_ALIASES: Record<string, string> = {
  WHAT: "WHAT",
  WHERE: "WHERE",
  WHEN: "WHEN",
  IMPACT: "IMPACT",
  IMPACTS: "IMPACTS",
  HAZARD: "HAZARD",
  SOURCE: "SOURCE",
  "ADDITIONAL DETAILS": "ADDITIONAL DETAILS",
  "PRECAUTIONARY/PREPAREDNESS ACTIONS": "PRECAUTIONARY ACTIONS",
  "PRECAUTIONARY PREPAREDNESS ACTIONS": "PRECAUTIONARY ACTIONS"
};

function cleanCountyToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(county|counties|parish|parishes|borough|census area|municipality|city and borough|city)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSectionLabel(value: string): string | null {
  const key = value
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  return SECTION_LABEL_ALIASES[key] ?? null;
}

function parseSectionLine(
  line: string
): {
  label: string;
  body: string;
} | null {
  const cleaned = line.replace(/^\*\s*/, "").trim();
  if (!cleaned) return null;

  const explicitMatch = cleaned.match(
    /^([A-Z][A-Z/\s]{2,44}?)(?:\s*\.\.\.|\s*:)\s*(.*)$/i
  );
  if (explicitMatch) {
    const label = normalizeSectionLabel(explicitMatch[1]);
    if (label) {
      return {
        label,
        body: explicitMatch[2].trim()
      };
    }
  }

  const compactMatch = cleaned.match(
    /^(WHAT|WHERE|WHEN|IMPACTS?|HAZARD|SOURCE|ADDITIONAL DETAILS)([A-Za-z0-9].*)$/i
  );
  if (compactMatch) {
    const label = normalizeSectionLabel(compactMatch[1]);
    if (label) {
      return {
        label,
        body: compactMatch[2].trim()
      };
    }
  }

  return null;
}

function titleCaseState(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function stateLabelFromCode(stateCode: string): string {
  const code = stateCode.trim().toUpperCase();
  if (!code || code === "US") return "United States";
  const slug = STATE_NAME_BY_CODE[code];
  if (!slug) return code;
  return titleCaseState(slug);
}

export function uniqueAffectedAreas(areaDesc: string): string[] {
  const raw = areaDesc.trim();
  if (!raw) return [];
  const pieces = (raw.includes(";") ? raw.split(";") : raw.split(","))
    .map((part) => part.trim().replace(/\.$/, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const piece of pieces) {
    const key = piece.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(piece);
    }
  }
  return unique;
}

export function normalizeSeverity(value: string): SeverityFilter {
  const clean = value.trim().toLowerCase();
  if (clean === "extreme") return "extreme";
  if (clean === "severe") return "severe";
  if (clean === "moderate") return "moderate";
  if (clean === "minor") return "minor";
  return "unknown";
}

export function classifyAlertType(event: string): AlertType {
  const clean = event.trim().toLowerCase();
  if (clean.includes("warning")) return "warning";
  if (clean.includes("watch")) return "watch";
  if (clean.includes("advisory")) return "advisory";
  if (clean.includes("statement")) return "statement";
  return "other";
}

export function parseTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

export function parseLifecycleStatus(value: unknown): AlertLifecycleStatus | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "new") return "new";
  if (normalized === "updated") return "updated";
  if (normalized === "extended") return "extended";
  if (normalized === "expiring_soon") return "expiring_soon";
  if (normalized === "expired") return "expired";
  if (normalized === "all_clear") return "all_clear";
  return null;
}

export function deriveAlertLifecycleStatus(
  alert: Pick<AlertRecord, "expires" | "lifecycleStatus">,
  nowMs = Date.now()
): AlertLifecycleStatus | null {
  const expiresMs = parseTime(alert.expires);
  if (expiresMs !== null) {
    if (expiresMs <= nowMs) return "expired";
    if (expiresMs - nowMs <= EXPIRING_SOON_MS) return "expiring_soon";
  }

  const normalizedFromPayload = parseLifecycleStatus(alert.lifecycleStatus);
  if (
    normalizedFromPayload === "new" ||
    normalizedFromPayload === "updated" ||
    normalizedFromPayload === "extended" ||
    normalizedFromPayload === "all_clear"
  ) {
    return normalizedFromPayload;
  }

  return null;
}

export function formatDateTime(value: string): string {
  const timestamp = parseTime(value);
  if (!timestamp) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

export function formatTimeFromNow(value: string): string {
  const timestamp = parseTime(value);
  if (!timestamp) return "Unknown";

  const diffMs = timestamp - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60_000);
  if (absMinutes < 1) return diffMs < 0 ? "Just expired" : "Expiring now";

  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  const pieces: string[] = [];
  if (hours > 0) pieces.push(`${hours}h`);
  if (minutes > 0) pieces.push(`${minutes}m`);

  const valueLabel = pieces.join(" ");
  return diffMs < 0 ? `${valueLabel} ago` : `in ${valueLabel}`;
}

export function formatTimeLeft(value: string): string {
  const timestamp = parseTime(value);
  if (!timestamp) return "Unknown";
  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return "Expired";

  const totalMinutes = Math.round(diffMs / 60_000);
  if (totalMinutes < 1) return "Less than 1m left";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m left`;
  if (minutes <= 0) return `${hours}h left`;
  return `${hours}h ${minutes}m left`;
}

export function formatLabel(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return "Unknown";
  return cleaned.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function alertAnchorId(rawId: string): string {
  const normalized = String(rawId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized ? `alert-${normalized}` : "alert-item";
}

export function alertEffectiveStartMs(alert: AlertRecord): number | null {
  return (
    parseTime(alert.onset) ??
    parseTime(alert.effective) ??
    parseTime(alert.sent) ??
    parseTime(alert.updated)
  );
}

export function alertEffectiveEndMs(alert: AlertRecord): number | null {
  return parseTime(alert.expires);
}

export function alertMatchesCounty(
  alert: AlertRecord,
  stateCode: string,
  countyName: string,
  countyCode: string
): boolean {
  const normalizedStateCode = stateCode.trim().toUpperCase();
  const targetCountyName = cleanCountyToken(countyName);
  const targetCountyCode = countyCode.replace(/\D/g, "").padStart(3, "0").slice(-3);

  if (targetCountyCode) {
    const targetUgc = `${normalizedStateCode}C${targetCountyCode}`;
    if (
      alert.ugc.some(
        (ugcCode) => String(ugcCode).trim().toUpperCase() === targetUgc
      )
    ) {
      return true;
    }
  }

  if (!targetCountyName) return false;

  const areaTokens = alert.areaDesc
    .split(/[;,]/)
    .map((part) => cleanCountyToken(part))
    .filter(Boolean);

  if (
    areaTokens.some(
      (token) =>
        token === targetCountyName ||
        token.includes(targetCountyName) ||
        targetCountyName.includes(token)
    )
  ) {
    return true;
  }

  const fullArea = cleanCountyToken(alert.areaDesc);
  return fullArea.includes(targetCountyName);
}

export function textLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let activeLabel: string | null = null;
  let activeParts: string[] = [];

  const flushSection = () => {
    if (!activeLabel) return;
    const body = activeParts.join(" ").replace(/\s+/g, " ").trim();
    output.push(body ? `${activeLabel}: ${body}` : `${activeLabel}:`);
    activeLabel = null;
    activeParts = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const section = parseSectionLine(line);
    if (section) {
      flushSection();
      activeLabel = section.label;
      if (section.body) activeParts.push(section.body);
      continue;
    }

    const plain = line.replace(/^\*\s*/, "").trim();
    if (!plain) continue;

    if (activeLabel) {
      activeParts.push(plain);
      continue;
    }

    output.push(plain);
  }

  flushSection();

  return output;
}

export function summaryFromAlert(alert: AlertRecord): string {
  if (alert.summary?.trim()) return alert.summary.trim();
  if (alert.headline.trim()) return alert.headline.trim();
  const descriptionLine = textLines(alert.description)[0];
  if (descriptionLine) return descriptionLine;
  return "Review details for location and timing.";
}

export function instructionsSummaryFromAlert(alert: AlertRecord): string {
  if (alert.instructionsSummary?.trim()) return alert.instructionsSummary.trim();
  const instructionLine = textLines(alert.instruction)[0];
  if (instructionLine) return instructionLine;
  return "";
}

export function canonicalAlertDetailPath(alert: Pick<AlertRecord, "id" | "detailUrl">): string {
  const detailUrl = String(alert.detailUrl || "").trim();
  if (detailUrl.startsWith("/alerts/")) {
    return detailUrl;
  }

  const id = String(alert.id || "").trim();
  if (!id) return "/alerts";
  return `/alerts/${encodeURIComponent(id)}`;
}

export function canonicalAlertCardPath(alert: Pick<AlertRecord, "id">): string {
  const id = String(alert.id || "").trim();
  const anchorId = alertAnchorId(id);
  const params = new URLSearchParams();
  if (id) {
    params.set("focusAlert", id);
  }
  const query = params.toString();
  return `/alerts${query ? `?${query}` : ""}#${anchorId}`;
}

export function priorityScore(alert: AlertRecord): number {
  const type = classifyAlertType(alert.event);
  const severity = normalizeSeverity(alert.severity);
  const urgency = alert.urgency.trim().toLowerCase() || "unknown";
  const certainty = alert.certainty.trim().toLowerCase() || "unknown";

  const updated = parseTime(alert.updated) ?? parseTime(alert.sent) ?? 0;
  const ageMinutes = Math.max(0, Math.floor((Date.now() - updated) / 60_000));
  const freshnessScore =
    ageMinutes <= 30 ? 25 : ageMinutes <= 120 ? 18 : ageMinutes <= 360 ? 10 : 5;

  return (
    alertTypeWeight[type] +
    severityWeight[severity] +
    (urgencyWeight[urgency] ?? urgencyWeight.unknown) +
    (certaintyWeight[certainty] ?? certaintyWeight.unknown) +
    freshnessScore
  );
}

const ALERT_IMPACT_CATEGORY_PRIORITY: AlertImpactCategory[] = [
  "tornado",
  "flood",
  "winter",
  "heat",
  "wind",
  "fire",
  "coastal",
  "marine",
  "air_quality",
  "other"
];

const MAJOR_EVENT_PATTERN =
  /(tornado warning|flash flood warning|flood warning|severe thunderstorm warning|extreme wind warning|high wind warning|hurricane warning|storm surge warning|blizzard warning|ice storm warning|excessive heat warning)/i;

export type ImpactCardTone = "critical" | "warning" | "advisory" | "info" | "clear";

export type AlertImpactForecastContext = {
  dayLabel?: string;
  precipitationChance?: number | null;
  windMph?: number | null;
  highF?: number | null;
  lowF?: number | null;
  daySummary?: string;
  nightSummary?: string;
};

export type AlertImpactCardModel = {
  id: string;
  title: string;
  detail: string;
  action: string;
  tone: ImpactCardTone;
};

export type AlertChangeSummaryCard = {
  id: AlertChangeType;
  count: number;
  title: string;
  detail: string;
  tone: ImpactCardTone;
};

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function localHourFromIso(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).getHours();
}

function resolveFallbackImpactCategories(event: string): AlertImpactCategory[] {
  const text = String(event || "").toLowerCase();
  if (includesAny(text, [/tornado/])) return ["tornado", "wind"];
  if (includesAny(text, [/flood|inundation|hydrologic/])) return ["flood"];
  if (
    includesAny(text, [
      /winter|snow|sleet|blizzard|ice storm|freezing rain|wind chill|freeze|frost/
    ])
  ) {
    return ["winter", "wind"];
  }
  if (includesAny(text, [/heat|hot weather|high temperature/])) return ["heat"];
  if (includesAny(text, [/wind|gust/])) return ["wind"];
  if (includesAny(text, [/red flag|fire weather|wildfire|smoke/])) return ["fire"];
  if (includesAny(text, [/coastal|surf|rip current|storm surge/])) return ["coastal"];
  if (includesAny(text, [/marine|gale|small craft|hazardous seas|tsunami/])) {
    return ["marine", "wind"];
  }
  if (includesAny(text, [/air quality|air stagnation|ozone|particulate/])) {
    return ["air_quality"];
  }
  return ["other"];
}

export function resolveAlertImpactCategories(
  alert: Pick<AlertRecord, "event" | "impactCategories">
): AlertImpactCategory[] {
  const fromPayload = Array.isArray(alert.impactCategories)
    ? alert.impactCategories.filter((category): category is AlertImpactCategory =>
        ALERT_IMPACT_CATEGORY_PRIORITY.includes(category)
      )
    : [];
  const source = fromPayload.length > 0 ? fromPayload : resolveFallbackImpactCategories(alert.event);
  const unique = Array.from(new Set(source));
  return ALERT_IMPACT_CATEGORY_PRIORITY.filter((category) => unique.includes(category));
}

export function isMajorImpactEvent(event: string): boolean {
  return MAJOR_EVENT_PATTERN.test(String(event || ""));
}

function addImpactCard(
  cards: AlertImpactCardModel[],
  card: AlertImpactCardModel,
  maxCards: number
): void {
  if (cards.length >= maxCards) return;
  if (cards.some((existing) => existing.id === card.id)) return;
  cards.push(card);
}

type BuildImpactCardsOptions = {
  forecastContext?: AlertImpactForecastContext | null;
  maxCards?: number;
  nowMs?: number;
};

export function buildImpactCardsForAlert(
  alert: Pick<
    AlertRecord,
    | "event"
    | "severity"
    | "areaDesc"
    | "impactCategories"
    | "expires"
    | "lifecycleStatus"
    | "isMajor"
  >,
  options: BuildImpactCardsOptions = {}
): AlertImpactCardModel[] {
  const nowMs = options.nowMs ?? Date.now();
  const maxCards = Math.max(1, options.maxCards ?? 3);
  const lifecycleStatus = deriveAlertLifecycleStatus(
    {
      expires: alert.expires,
      lifecycleStatus: alert.lifecycleStatus
    },
    nowMs
  );
  const categories = resolveAlertImpactCategories({
    event: alert.event,
    impactCategories: alert.impactCategories
  });
  const expiresMs = parseTime(alert.expires);
  const timeLabel =
    expiresMs !== null && Number.isFinite(expiresMs)
      ? formatTimeFromNow(alert.expires)
      : "soon";
  const areaLabel = alert.areaDesc?.trim() || "your area";
  const severityLabel = formatLabel(alert.severity || "Unknown");
  const isMajor = alert.isMajor === true || isMajorImpactEvent(alert.event);
  const cards: AlertImpactCardModel[] = [];

  if (lifecycleStatus === "all_clear") {
    addImpactCard(
      cards,
      {
        id: "all-clear",
        title: "All clear confirmed",
        detail: `The active threat has cleared for ${areaLabel}.`,
        action: "Resume plans carefully and keep monitoring local conditions.",
        tone: "clear"
      },
      maxCards
    );
    return cards;
  }

  if (lifecycleStatus === "expired") {
    addImpactCard(
      cards,
      {
        id: "expired-window",
        title: "Alert window ended",
        detail: `This alert has expired ${timeLabel} for ${areaLabel}.`,
        action: "Watch for lingering hazards before travel or outdoor plans.",
        tone: isMajor ? "warning" : "info"
      },
      maxCards
    );
    if (categories.includes("flood")) {
      addImpactCard(
        cards,
        {
          id: "expired-flood-recheck",
          title: "Post-flood route check",
          detail: "Water can linger after expiry, especially in low crossings and underpasses.",
          action: "Recheck travel routes and avoid roads with standing or moving water.",
          tone: "info"
        },
        maxCards
      );
    } else if (categories.includes("tornado") || categories.includes("wind")) {
      addImpactCard(
        cards,
        {
          id: "expired-wind-debris",
          title: "Storm cleanup safety",
          detail: "Fallen limbs, unstable structures, and downed lines can remain hazardous.",
          action: "Use daylight for cleanup and stay clear of damaged utilities.",
          tone: "info"
        },
        maxCards
      );
    } else if (categories.includes("winter")) {
      addImpactCard(
        cards,
        {
          id: "expired-winter-ice",
          title: "Residual ice risk",
          detail: "Refreeze can continue after the formal alert window closes.",
          action: "Slow down travel and recheck sidewalks, bridges, and untreated surfaces.",
          tone: "info"
        },
        maxCards
      );
    } else if (categories.includes("heat")) {
      addImpactCard(
        cards,
        {
          id: "expired-heat-recovery",
          title: "Heat recovery check",
          detail: "Heat impacts can persist indoors after the alert expires.",
          action: "Continue hydration and cool-down checks for vulnerable family members.",
          tone: "info"
        },
        maxCards
      );
    }
    return cards;
  }

  if (categories.includes("tornado")) {
    addImpactCard(
      cards,
      {
        id: "tornado-shelter",
        title: "Shelter decision window",
        detail: `Tornado risk remains ${severityLabel.toLowerCase()} and active ${timeLabel}.`,
        action: "Move everyone to a lowest interior room away from windows now.",
        tone: "critical"
      },
      maxCards
    );
  }

  if (categories.includes("flood")) {
    addImpactCard(
      cards,
      {
        id: "flood-commute",
        title: "Commute route risk",
        detail: `Flooding can cut roads quickly across ${areaLabel}.`,
        action: "Use higher-ground routes and never drive through water.",
        tone: "warning"
      },
      maxCards
    );
  }

  if (categories.includes("winter")) {
    addImpactCard(
      cards,
      {
        id: "winter-road",
        title: "Icy travel risk",
        detail: "Rapid freeze or snow bands can make roads hazardous with little warning.",
        action: "Delay non-essential trips and pack winter gear before leaving.",
        tone: "warning"
      },
      maxCards
    );
  }

  if (categories.includes("heat")) {
    addImpactCard(
      cards,
      {
        id: "heat-health",
        title: "Heat stress window",
        detail: `Heat impacts are ${severityLabel.toLowerCase()} for ${areaLabel}.`,
        action: "Shift outdoor activity early, hydrate often, and check vulnerable people.",
        tone: "warning"
      },
      maxCards
    );
  }

  if (categories.includes("wind")) {
    addImpactCard(
      cards,
      {
        id: "wind-power",
        title: "Power outage prep",
        detail: "Strong gusts can down limbs and trigger localized outages.",
        action: "Charge devices, secure loose items, and keep flashlights ready.",
        tone: isMajor ? "warning" : "advisory"
      },
      maxCards
    );
  }

  const expiresHour = localHourFromIso(alert.expires);
  if (expiresHour !== null && (expiresHour >= 21 || expiresHour < 6)) {
    addImpactCard(
      cards,
      {
        id: "overnight-risk",
        title: "Overnight risk window",
        detail: "Conditions may worsen while people are asleep.",
        action: "Keep sound-on alerts enabled and place safety gear by the bed.",
        tone: isMajor ? "warning" : "info"
      },
      maxCards
    );
  }

  if (expiresHour !== null && expiresHour >= 14 && expiresHour <= 18) {
    addImpactCard(
      cards,
      {
        id: "school-pickup",
        title: "School pickup timing",
        detail: "Hazards overlap afternoon pickup and after-school travel windows.",
        action: "Confirm an early pickup plan and safest route before dismissal.",
        tone: "advisory"
      },
      maxCards
    );
  }

  const forecastContext = options.forecastContext;
  if (forecastContext) {
    const precipChance =
      typeof forecastContext.precipitationChance === "number" &&
      Number.isFinite(forecastContext.precipitationChance)
        ? forecastContext.precipitationChance
        : null;
    const windMph =
      typeof forecastContext.windMph === "number" && Number.isFinite(forecastContext.windMph)
        ? forecastContext.windMph
        : null;
    if ((precipChance !== null && precipChance >= 45) || (windMph !== null && windMph >= 25)) {
      addImpactCard(
        cards,
        {
          id: "outdoor-plan",
          title: "Outdoor plan risk",
          detail: `Forecast support for ${forecastContext.dayLabel || "today"} still shows unstable conditions.`,
          action: "Move outdoor plans indoors and tighten arrival/departure timing.",
          tone: "advisory"
        },
        maxCards
      );
    }
  }

  if (cards.length === 0) {
    addImpactCard(
      cards,
      {
        id: "general-readiness",
        title: "Action check",
        detail: `Conditions remain ${severityLabel.toLowerCase()} for ${areaLabel}.`,
        action: "Review instructions, confirm contacts, and keep your phone charged.",
        tone: "info"
      },
      maxCards
    );
  }

  return cards;
}

export function buildAlertChangeSummaryCards(
  changes: AlertChangeRecord[],
  placeLabel: string
): AlertChangeSummaryCard[] {
  const counts = changes.reduce<Record<AlertChangeType, number>>(
    (accumulator, change) => {
      accumulator[change.changeType] += 1;
      return accumulator;
    },
    {
      new: 0,
      updated: 0,
      extended: 0,
      expired: 0,
      all_clear: 0
    }
  );

  const cards: AlertChangeSummaryCard[] = [];
  if (counts.new > 0) {
    cards.push({
      id: "new",
      count: counts.new,
      title: "New Alerts",
      detail: `${counts.new} new alert${counts.new === 1 ? "" : "s"} posted for ${placeLabel}.`,
      tone: "critical"
    });
  }
  if (counts.updated > 0) {
    cards.push({
      id: "updated",
      count: counts.updated,
      title: "Updated Alerts",
      detail: `${counts.updated} alert${counts.updated === 1 ? "" : "s"} changed wording, area, or severity.`,
      tone: "warning"
    });
  }
  if (counts.extended > 0) {
    cards.push({
      id: "extended",
      count: counts.extended,
      title: "Extended Windows",
      detail: `${counts.extended} alert${counts.extended === 1 ? "" : "s"} now run longer than before.`,
      tone: "advisory"
    });
  }
  if (counts.expired > 0) {
    cards.push({
      id: "expired",
      count: counts.expired,
      title: "Expired Alerts",
      detail: `${counts.expired} alert window${counts.expired === 1 ? "" : "s"} closed since your last visit.`,
      tone: "info"
    });
  }
  if (counts.all_clear > 0) {
    cards.push({
      id: "all_clear",
      count: counts.all_clear,
      title: "All Clear Updates",
      detail: `${counts.all_clear} area${counts.all_clear === 1 ? "" : "s"} moved to all clear conditions.`,
      tone: "clear"
    });
  }

  return cards;
}

export function selectClosureHighlights(
  changes: AlertChangeRecord[],
  limit = 3
): AlertChangeRecord[] {
  return [...changes]
    .filter((change) => change.changeType === "expired" || change.changeType === "all_clear")
    .sort((a, b) => {
      const aMajor = isMajorImpactEvent(a.event) || a.changeType === "all_clear" ? 1 : 0;
      const bMajor = isMajorImpactEvent(b.event) || b.changeType === "all_clear" ? 1 : 0;
      if (aMajor !== bMajor) return bMajor - aMajor;
      return Date.parse(b.changedAt) - Date.parse(a.changedAt);
    })
    .slice(0, Math.max(1, limit));
}
