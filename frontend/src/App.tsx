import { useEffect, useMemo, useState, type FormEvent } from "react";
import { buildApiUrl, fetchAlerts } from "./lib/alerts";
import type { AlertRecord, AlertsPayload } from "./types";

type AlertType = "warning" | "watch" | "advisory" | "statement" | "other";
type AlertTypeFilter = AlertType | "all";
type SeverityFilter =
  | "all"
  | "extreme"
  | "severe"
  | "moderate"
  | "minor"
  | "unknown";
type SortMode = "priority" | "expires" | "latest";
type LoadState = "loading" | "ready" | "error";

const alertTypeLabel: Record<AlertTypeFilter, string> = {
  all: "All alert types",
  warning: "Warnings",
  watch: "Watches",
  advisory: "Advisories",
  statement: "Statements",
  other: "Other"
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

interface SavedLocationPreference {
  stateCode: string;
  rawInput: string;
  label: string;
  countyName?: string;
  countyCode?: string;
  savedAt: string;
}

interface GeocodeLocationPayload {
  city?: string;
  state?: string;
  label?: string;
  county?: string;
  countyCode?: string;
  error?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

const LOCATION_STORAGE_KEY = "lwa:preferred-state:v1";
const LOCATION_MODAL_DISMISSED_KEY = "lwa:location-modal-dismissed:v1";

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

const STATE_ALIAS_TO_CODE: Record<string, string> = Object.entries(
  STATE_NAME_BY_CODE
).reduce<Record<string, string>>((accumulator, [code, name]) => {
  accumulator[code.toLowerCase()] = code;
  accumulator[name] = code;
  return accumulator;
}, {
  "washington dc": "DC",
  "washington d c": "DC",
  "district columbia": "DC"
});

function cleanToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

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

function normalizeCountyCode(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.padStart(3, "0").slice(-3);
}

function toStateCode(value: string): string | null {
  const alias = cleanToken(value);
  if (!alias) return null;
  return STATE_ALIAS_TO_CODE[alias] ?? null;
}

function resolveStateFromText(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  const direct = toStateCode(input);
  if (direct) return direct;

  const commaParts = input.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    const commaState = toStateCode(commaParts[commaParts.length - 1]);
    if (commaState) return commaState;
  }

  const words = input.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const lastWordState = toStateCode(words[words.length - 1]);
    if (lastWordState) return lastWordState;
  }

  if (words.length > 2) {
    const lastTwo = toStateCode(words.slice(-2).join(" "));
    if (lastTwo) return lastTwo;
  }

  return null;
}

function isLikelyStateOnlyInput(value: string): boolean {
  const input = value.trim();
  if (!input || input.includes(",")) return false;
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  return toStateCode(input) !== null;
}

function alertMatchesCounty(
  alert: AlertRecord,
  stateCode: string,
  countyName: string,
  countyCode: string
): boolean {
  const normalizedStateCode = stateCode.trim().toUpperCase();
  const targetCountyName = cleanCountyToken(countyName);
  const targetCountyCode = normalizeCountyCode(countyCode);

  if (targetCountyCode) {
    const targetUgc = `${normalizedStateCode}C${targetCountyCode}`;
    if (
      (alert.ugc ?? []).some(
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

function readSavedLocationPreference(): SavedLocationPreference | null {
  try {
    const raw = window.localStorage.getItem(LOCATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedLocationPreference;
    if (!parsed || typeof parsed !== "object") return null;
    const stateCode = toStateCode(parsed.stateCode || "");
    if (!stateCode) return null;
    return {
      stateCode,
      rawInput: String(parsed.rawInput || stateCode),
      label: String(parsed.label || stateCode),
      countyName: parsed.countyName ? String(parsed.countyName) : undefined,
      countyCode: parsed.countyCode
        ? normalizeCountyCode(String(parsed.countyCode))
        : undefined,
      savedAt: String(parsed.savedAt || "")
    };
  } catch {
    return null;
  }
}

function saveLocationPreference(preference: SavedLocationPreference): void {
  window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(preference));
}

function isLocationModalDismissed(): boolean {
  try {
    return window.localStorage.getItem(LOCATION_MODAL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setLocationModalDismissed(dismissed: boolean): void {
  try {
    if (dismissed) {
      window.localStorage.setItem(LOCATION_MODAL_DISMISSED_KEY, "1");
    } else {
      window.localStorage.removeItem(LOCATION_MODAL_DISMISSED_KEY);
    }
  } catch {
    // Ignore localStorage failures in private mode or restricted contexts.
  }
}

async function parseGeocodeResponse(
  response: Response,
  fallbackError: string
): Promise<GeocodeLocationPayload> {
  const raw = await response.text();
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const looksLikeHtml = /^\s*</.test(raw);

  if (!contentType.includes("application/json") || looksLikeHtml) {
    throw new Error(
      "Location lookup is unavailable right now. Please enter a state only, or try again in a moment."
    );
  }

  let payload: GeocodeLocationPayload;
  try {
    payload = JSON.parse(raw) as GeocodeLocationPayload;
  } catch {
    throw new Error(
      "Location lookup returned an unexpected response. Please enter a state only, or try again."
    );
  }

  if (!response.ok) {
    throw new Error(payload.error || fallbackError);
  }

  return payload;
}

async function resolveStateFromZip(
  zip: string
): Promise<{
  stateCode: string;
  label: string;
  countyName?: string;
  countyCode?: string;
}> {
  const endpoint = buildApiUrl(`/api/geocode?zip=${encodeURIComponent(zip)}`);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  const payload = await parseGeocodeResponse(response, "ZIP code lookup failed.");

  const stateCode = toStateCode(payload.state ?? "");
  if (!stateCode) {
    throw new Error("ZIP code lookup did not return a valid state.");
  }

  const city = (payload.city ?? "").trim();
  const countyName = (payload.county ?? "").trim();
  const countyCode = normalizeCountyCode(payload.countyCode ?? "");
  return {
    stateCode,
    label: city ? `${city}, ${stateCode}` : stateCode,
    countyName: countyName || undefined,
    countyCode: countyCode || undefined
  };
}

async function resolveLocationFromQuery(
  query: string
): Promise<{
  stateCode: string;
  label: string;
  countyName?: string;
  countyCode?: string;
}> {
  const endpoint = buildApiUrl(`/api/geocode?query=${encodeURIComponent(query)}`);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  const payload = await parseGeocodeResponse(response, "Location lookup failed.");

  const stateCode = toStateCode(payload.state ?? "");
  if (!stateCode) {
    throw new Error("Could not determine a valid state for that location.");
  }

  const countyName = (payload.county ?? "").trim();
  const countyCode = normalizeCountyCode(payload.countyCode ?? "");
  const label = (payload.label ?? "").trim() || `${query}, ${stateCode}`;

  return {
    stateCode,
    label,
    countyName: countyName || undefined,
    countyCode: countyCode || undefined
  };
}

function normalizeSeverity(value: string): SeverityFilter {
  const clean = value.trim().toLowerCase();
  if (clean === "extreme") return "extreme";
  if (clean === "severe") return "severe";
  if (clean === "moderate") return "moderate";
  if (clean === "minor") return "minor";
  return "unknown";
}

function classifyAlertType(event: string): AlertType {
  const clean = event.trim().toLowerCase();
  if (clean.includes("warning")) return "warning";
  if (clean.includes("watch")) return "watch";
  if (clean.includes("advisory")) return "advisory";
  if (clean.includes("statement")) return "statement";
  return "other";
}

function parseTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDateTime(value: string): string {
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

function formatTimeFromNow(value: string): string {
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

function formatTimeLeft(value: string): string {
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

function formatLabel(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return "Unknown";
  return cleaned.replace(/\b\w/g, (match) => match.toUpperCase());
}

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

function summaryFromAlert(alert: AlertRecord): string {
  if (alert.headline.trim()) return alert.headline.trim();
  const descriptionLine = textLines(alert.description)[0];
  if (descriptionLine) return descriptionLine;
  return "Review details for location and timing.";
}

function textLines(value: string): string[] {
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

function titleCaseState(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function stateLabelFromCode(stateCode: string): string {
  const code = stateCode.trim().toUpperCase();
  if (!code || code === "US") return "United States";
  const slug = STATE_NAME_BY_CODE[code];
  if (!slug) return code;
  return titleCaseState(slug);
}

function uniqueAffectedAreas(areaDesc: string): string[] {
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

function priorityScore(alert: AlertRecord): number {
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

function AlertCard({ alert, index }: { alert: AlertRecord; index: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const description = textLines(alert.description);
  const instruction = textLines(alert.instruction);
  const sourceLabel = alert.stateCode.trim() ? alert.stateCode : "US";
  const summary = summaryFromAlert(alert);
  const sentTime = alert.sent || alert.effective || alert.onset;
  const updatedTime = alert.updated || sentTime;
  const sectionValue = (lines: string[], labels: string[]): string => {
    for (const line of lines) {
      for (const label of labels) {
        const prefix = `${label}:`;
        if (line.toUpperCase().startsWith(prefix)) {
          return line.slice(prefix.length).trim();
        }
      }
    }
    return "";
  };

  const what = sectionValue(description, ["WHAT", "HAZARD"]) || summary;
  const where =
    sectionValue(description, ["WHERE"]) ||
    alert.areaDesc ||
    "Area details unavailable.";
  const when = sectionValue(description, ["WHEN"]);
  const impacts = sectionValue(description, ["IMPACTS", "IMPACT"]);
  const additional = sectionValue(description, ["ADDITIONAL DETAILS"]);
  const instructionsText =
    sectionValue(instruction, ["INSTRUCTIONS", "PRECAUTIONARY ACTIONS"]) ||
    instruction.join(" ").trim();
  const areaList = uniqueAffectedAreas(alert.areaDesc || where);
  const countyCount = areaList.length || 1;
  const stateLabel = stateLabelFromCode(sourceLabel);
  const stateCountySummary = `${stateLabel} • ${countyCount} ${
    countyCount === 1 ? "county" : "counties"
  }`;

  return (
    <article
      className="alert-sheet"
      style={{ animationDelay: `${Math.min(index * 45, 420)}ms` }}
    >
      <header className="sheet-head">
        <div>
          <p className="sheet-event">{(alert.event || "Weather Alert").toUpperCase()}</p>
          <h3>{stateCountySummary}</h3>
        </div>
      </header>

      <section className="sheet-callout">
        <h4>PRIMARY ALERT AREA</h4>
        <p>{where}</p>
      </section>

      <section className="sheet-time-grid">
        <div className="sheet-time-cell">
          <h5>ISSUED</h5>
          <p>{formatDateTime(sentTime)}</p>
        </div>
        <div className="sheet-time-cell">
          <h5>EXPIRES</h5>
          <p>{formatDateTime(alert.expires)}</p>
        </div>
        <div className="sheet-time-cell">
          <h5>TIME LEFT</h5>
          <p>{formatTimeLeft(alert.expires)}</p>
        </div>
      </section>

      <button
        type="button"
        className="sheet-toggle"
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
      >
        {isExpanded ? "Collapse details" : "Expand details"}
      </button>

      {isExpanded ? (
        <>
          <section className="sheet-section">
            <h4>AFFECTED AREAS</h4>
            <p>{alert.areaDesc || where}</p>
          </section>

          <section className="sheet-section">
            <h4>WHAT</h4>
            <p>{what}</p>
          </section>

          {when ? (
            <section className="sheet-section">
              <h4>WHEN</h4>
              <p>{when}</p>
            </section>
          ) : null}

          {impacts ? (
            <section className="sheet-section">
              <h4>IMPACTS</h4>
              <p>{impacts}</p>
            </section>
          ) : null}

          {instructionsText ? (
            <section className="sheet-section">
              <h4>INSTRUCTIONS</h4>
              <p>{instructionsText}</p>
            </section>
          ) : null}

          {additional ? (
            <section className="sheet-section">
              <h4>ADDITIONAL DETAILS</h4>
              <p>{additional}</p>
            </section>
          ) : null}

          <footer className="sheet-footer">
            <div>
              <span className="sheet-footer-label">Status</span>
              <p>{formatLabel(alert.status)}</p>
            </div>
            <div>
              <span className="sheet-footer-label">Severity</span>
              <p>{formatLabel(alert.severity)}</p>
            </div>
            <div>
              <span className="sheet-footer-label">Updated</span>
              <p>{formatDateTime(updatedTime)}</p>
            </div>
          </footer>

          {alert.nwsUrl.trim().startsWith("http") ? (
            <a
              className="sheet-cta"
              href={alert.nwsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View official NWS alert
            </a>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

export default function App() {
  const [payload, setPayload] = useState<AlertsPayload | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedPreference, setSavedPreference] =
    useState<SavedLocationPreference | null>(null);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [locationInput, setLocationInput] = useState("");
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isSavingLocation, setIsSavingLocation] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );

  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<AlertTypeFilter>("all");
  const [severityFilter, setSeverityFilter] =
    useState<SeverityFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("priority");
  const [showFilters, setShowFilters] = useState(true);

  useEffect(() => {
    const storedPreference = readSavedLocationPreference();
    if (storedPreference) {
      setLocationModalDismissed(false);
      setSavedPreference(storedPreference);
      setStateFilter(storedPreference.stateCode);
      return;
    }
    if (isLocationModalDismissed()) {
      return;
    }
    setShowLocationModal(true);
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
      setShowInstallPrompt(true);
    };

    const handleAppInstalled = () => {
      setInstallPromptEvent(null);
      setShowInstallPrompt(false);
    };

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadState("loading");

      try {
        const data = await fetchAlerts();
        if (cancelled) return;
        setPayload(data);
        setErrorMessage(null);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load weather alerts.";
        setErrorMessage(message);
        setLoadState("error");
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const alerts = payload?.alerts ?? [];

  const states = useMemo(() => {
    const values = new Set(
      alerts.map((alert) => alert.stateCode.trim().toUpperCase()).filter(Boolean)
    );
    if (stateFilter !== "all") {
      values.add(stateFilter);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }, [alerts, stateFilter]);

  const activeCountyName =
    stateFilter !== "all" && savedPreference?.stateCode === stateFilter
      ? savedPreference.countyName ?? ""
      : "";
  const activeCountyCode =
    stateFilter !== "all" && savedPreference?.stateCode === stateFilter
      ? savedPreference.countyCode ?? ""
      : "";

  const filteredAlerts = useMemo(() => {
    const search = query.trim().toLowerCase();

    return alerts.filter((alert) => {
      const type = classifyAlertType(alert.event);
      const severity = normalizeSeverity(alert.severity);
      const state = alert.stateCode.trim().toUpperCase() || "US";
      const textBlob = [
        alert.event,
        alert.areaDesc,
        alert.headline,
        alert.description,
        alert.instruction,
        alert.severity,
        alert.urgency,
        alert.certainty
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch = !search || textBlob.includes(search);
      const matchesState = stateFilter === "all" || state === stateFilter;
      const matchesType = typeFilter === "all" || type === typeFilter;
      const matchesSeverity =
        severityFilter === "all" || severity === severityFilter;
      const matchesCounty =
        (!activeCountyName && !activeCountyCode) ||
        alertMatchesCounty(alert, state, activeCountyName, activeCountyCode);

      return (
        matchesSearch &&
        matchesState &&
        matchesType &&
        matchesSeverity &&
        matchesCounty
      );
    });
  }, [
    activeCountyCode,
    activeCountyName,
    alerts,
    query,
    severityFilter,
    stateFilter,
    typeFilter
  ]);

  const sortedAlerts = useMemo(() => {
    const items = [...filteredAlerts];
    items.sort((a, b) => {
      if (sortMode === "priority") {
        return priorityScore(b) - priorityScore(a);
      }

      if (sortMode === "expires") {
        const expiresA = parseTime(a.expires) ?? Number.MAX_SAFE_INTEGER;
        const expiresB = parseTime(b.expires) ?? Number.MAX_SAFE_INTEGER;
        return expiresA - expiresB;
      }

      const updatedA = parseTime(a.updated) ?? parseTime(a.sent) ?? 0;
      const updatedB = parseTime(b.updated) ?? parseTime(b.sent) ?? 0;
      return updatedB - updatedA;
    });
    return items;
  }, [filteredAlerts, sortMode]);

  const warningCount = useMemo(
    () => alerts.filter((alert) => classifyAlertType(alert.event) === "warning")
      .length,
    [alerts]
  );

  const watchCount = useMemo(
    () => alerts.filter((alert) => classifyAlertType(alert.event) === "watch").length,
    [alerts]
  );

  const expiringSoonCount = useMemo(
    () =>
      alerts.filter((alert) => {
        const expiresAt = parseTime(alert.expires);
        if (!expiresAt) return false;
        const diff = expiresAt - Date.now();
        return diff >= 0 && diff <= 2 * 60 * 60 * 1000;
      }).length,
    [alerts]
  );

  const installPwa = async () => {
    if (!installPromptEvent) return;
    try {
      await installPromptEvent.prompt();
      const result = await installPromptEvent.userChoice;
      if (result.outcome === "accepted") {
        setShowInstallPrompt(false);
        setInstallPromptEvent(null);
      }
    } catch {
      setShowInstallPrompt(false);
    }
  };

  const openLocationModal = () => {
    setLocationError(null);
    setLocationInput(
      savedPreference?.rawInput ?? (stateFilter === "all" ? "" : stateFilter)
    );
    setLocationModalDismissed(false);
    setShowLocationModal(true);
  };

  const clearCountyFocus = () => {
    if (!savedPreference) return;
    const updatedPreference: SavedLocationPreference = {
      ...savedPreference,
      countyName: undefined,
      countyCode: undefined,
      savedAt: new Date().toISOString()
    };
    saveLocationPreference(updatedPreference);
    setSavedPreference(updatedPreference);
  };

  const handleLocationExit = () => {
    setLocationError(null);
    setShowLocationModal(false);
    setLocationModalDismissed(true);
  };

  const handleLocationSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rawInput = locationInput.trim();

    if (!rawInput) {
      setLocationError("Enter City, State, State, or ZIP code.");
      return;
    }

    setLocationError(null);
    setIsSavingLocation(true);

    try {
      let stateCode: string | null = null;
      let label = rawInput;
      let countyName: string | undefined;
      let countyCode: string | undefined;

      if (/^\d{5}$/.test(rawInput)) {
        const resolved = await resolveStateFromZip(rawInput);
        stateCode = resolved.stateCode;
        label = resolved.label;
        countyName = resolved.countyName;
        countyCode = resolved.countyCode;
      } else if (isLikelyStateOnlyInput(rawInput)) {
        stateCode = toStateCode(rawInput);
      } else {
        const resolved = await resolveLocationFromQuery(rawInput);
        stateCode = resolved.stateCode;
        label = resolved.label;
        countyName = resolved.countyName;
        countyCode = resolved.countyCode;
      }

      if (!stateCode) {
        stateCode = resolveStateFromText(rawInput);
      }

      if (!stateCode) {
        throw new Error(
          "Could not determine a state from that entry. Use format like \"Louisville, KY\", \"Kentucky\", or \"40202\"."
        );
      }

      const preference: SavedLocationPreference = {
        stateCode,
        rawInput,
        label,
        countyName,
        countyCode,
        savedAt: new Date().toISOString()
      };

      saveLocationPreference(preference);
      setLocationModalDismissed(false);
      setSavedPreference(preference);
      setStateFilter(stateCode);
      setShowLocationModal(false);
    } catch (error) {
      setLocationError(
        error instanceof Error
          ? error.message
          : "Unable to save that location right now."
      );
    } finally {
      setIsSavingLocation(false);
    }
  };

  return (
    <div className="page-shell">
      <div className="background-orb orb-one" />
      <div className="background-orb orb-two" />
      <main className="app-shell">
        <header className="site-header">
          <div>
            <p className="eyebrow">LiveWeatherAlerts.com</p>
            <h1>Weather Alerts</h1>
            <p className="subtitle">
              Focused, readable, real-time severe weather alerts from NOAA/NWS.
            </p>
          </div>
        </header>

        {showInstallPrompt ? (
          <section className="install-banner" role="status">
            <p>Install this app for a faster mobile experience and home-screen alerts access.</p>
            <div className="install-actions">
              <button type="button" className="save-location-btn" onClick={installPwa}>
                Install App
              </button>
              <button
                type="button"
                className="text-btn"
                onClick={() => setShowInstallPrompt(false)}
              >
                Not now
              </button>
            </div>
          </section>
        ) : null}

        {isOffline ? (
          <section className="message offline-message" role="status">
            You are offline. Showing the most recent cached alert data.
          </section>
        ) : null}

        <section className="metric-grid">
          <article className="metric-card">
            <p>Total Active Alerts</p>
            <strong>{alerts.length}</strong>
          </article>
          <article className="metric-card warning-metric">
            <p>Warnings</p>
            <strong>{warningCount}</strong>
          </article>
          <article className="metric-card">
            <p>Watches</p>
            <strong>{watchCount}</strong>
          </article>
          <article className="metric-card soon-metric">
            <p>Expiring Within 2h</p>
            <strong>{expiringSoonCount}</strong>
          </article>
        </section>

        <section className="filters-panel">
          <div className="filters-header">
            <p className="filters-title">Filters and Search</p>
            <button
              type="button"
              className="text-btn"
              onClick={() => setShowFilters((value) => !value)}
            >
              {showFilters ? "Hide" : "Show"}
            </button>
          </div>

          {showFilters ? (
            <>
              <label className="field">
                <span>Search alerts</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by event, area, severity, or text..."
                />
              </label>

              <div className="field-grid">
                <label className="field">
                  <span>State</span>
                  <select
                    value={stateFilter}
                    onChange={(event) => setStateFilter(event.target.value)}
                  >
                    <option value="all">All states</option>
                    {states.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Type</span>
                  <select
                    value={typeFilter}
                    onChange={(event) =>
                      setTypeFilter(event.target.value as AlertTypeFilter)
                    }
                  >
                    {Object.entries(alertTypeLabel).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Severity</span>
                  <select
                    value={severityFilter}
                    onChange={(event) =>
                      setSeverityFilter(event.target.value as SeverityFilter)
                    }
                  >
                    <option value="all">All severities</option>
                    <option value="extreme">Extreme</option>
                    <option value="severe">Severe</option>
                    <option value="moderate">Moderate</option>
                    <option value="minor">Minor</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </label>

                <label className="field">
                  <span>Sort</span>
                  <select
                    value={sortMode}
                    onChange={(event) => setSortMode(event.target.value as SortMode)}
                  >
                    <option value="priority">Highest priority first</option>
                    <option value="expires">Expiring soonest first</option>
                    <option value="latest">Latest updated first</option>
                  </select>
                </label>
              </div>

              <div className="filters-actions">
                <button type="button" className="text-btn" onClick={openLocationModal}>
                  Change Default Location
                </button>
                {activeCountyName || activeCountyCode ? (
                  <button type="button" className="text-btn" onClick={clearCountyFocus}>
                    Clear County Focus
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </section>

        {errorMessage ? (
          <section className="message error-message" role="alert">
            <strong>Could not load alerts:</strong> {errorMessage}
          </section>
        ) : null}

        <section className="alerts-panel">
          {loadState === "loading" && alerts.length === 0 ? (
            <div className="skeleton-grid">
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-card" />
            </div>
          ) : null}

          {loadState !== "loading" && sortedAlerts.length === 0 ? (
            <div className="empty-state">
              <h2>No matching alerts</h2>
              <p>
                There are no active alerts for the current filters. Clear one or
                more filters to broaden results.
              </p>
            </div>
          ) : null}

          {sortedAlerts.map((alert, index) => (
            <AlertCard key={`${alert.id}-${alert.sent}-${index}`} alert={alert} index={index} />
          ))}
        </section>

        <footer className="site-footer">
          <p>
            Data source: NOAA/NWS active alerts feed.
          </p>
        </footer>

        {showLocationModal ? (
          <section
            className="modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="location-modal-title"
          >
            <div className="location-modal">
              <p className="modal-eyebrow">Set your default area</p>
              <h2 id="location-modal-title">Where should we focus alerts?</h2>
              <p className="modal-copy">
                Enter <strong>City, State</strong>, <strong>State</strong>, or{" "}
                <strong>ZIP code</strong>. We save it in your browser so future
                visits open filtered to that state. City/ZIP entries also apply
                county-level filtering when county data is available.
              </p>

              <form className="location-form" onSubmit={handleLocationSubmit}>
                <label className="field">
                  <span>Location</span>
                  <input
                    autoFocus
                    value={locationInput}
                    onChange={(inputEvent) => setLocationInput(inputEvent.target.value)}
                    placeholder="Examples: Columbus, OH · Ohio · 43215"
                  />
                </label>

                {locationError ? (
                  <p className="modal-error" role="alert">
                    {locationError}
                  </p>
                ) : null}

                <div className="modal-actions">
                  <button
                    type="submit"
                    className="save-location-btn"
                    disabled={isSavingLocation}
                  >
                    {isSavingLocation ? "Saving..." : "Save Location"}
                  </button>
                  <button
                    type="button"
                    className="text-btn"
                    disabled={isSavingLocation}
                    onClick={handleLocationExit}
                  >
                    Skip for now
                  </button>
                </div>
              </form>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
