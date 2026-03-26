// shared alert data type
export type AlertItem = {
  id: string;
  stateCode: string;
  countyFips?: string | null;
  event: string;
  areaDesc: string;
  severity: string;
  status: string;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  sent: string;
  effective: string;
  onset: string;
  expires: string;
  updated: string;
  nwsUrl: string;
};

export type HeroVariant =
  | "tornado"
  | "thunderstorm"
  | "flood"
  | "winter"
  | "ice"
  | "wind"
  | "fog"
  | "heat"
  | "cold"
  | "fire"
  | "marine" // 👈 NEW
  | "default";

// Severity and alert ordering utilities
export function severityTone(severity?: string) {
  const s = String(severity || "").toLowerCase();
  if (s === "extreme") return "from-red-600 to-red-800";
  if (s === "severe") return "from-orange-500 to-orange-700";
  if (s === "moderate") return "from-yellow-400 to-yellow-600";
  if (s === "minor") return "from-blue-500 to-blue-700";
  return "from-red-600 to-red-800";
}

export function getAlertPriority(event: string) {
  const e = String(event || "").toLowerCase();

  if (e.includes("warning")) return 4;
  if (e.includes("watch")) return 3;
  if (e.includes("advisory")) return 2;
  if (e.includes("statement")) return 1;
  return 0;
}

export function getSeverityPriority(severity?: string) {
  const s = String(severity || "").toLowerCase();

  if (s === "extreme") return 4;
  if (s === "severe") return 3;
  if (s === "moderate") return 2;
  if (s === "minor") return 1;
  return 0;
}

export function sortAlerts(alerts: AlertItem[]) {
  return [...alerts].sort((a, b) => {
    const typeDelta = getAlertPriority(b.event) - getAlertPriority(a.event);
    if (typeDelta !== 0) return typeDelta;

    const severityDelta = getSeverityPriority(b.severity) - getSeverityPriority(a.severity);
    if (severityDelta !== 0) return severityDelta;

    const urgencyRank: Record<string, number> = {
      immediate: 3,
      expected: 2,
      future: 1,
      past: 0,
      unknown: 0,
    };

    const certaintyRank: Record<string, number> = {
      observed: 3,
      likely: 2,
      possible: 1,
      unlikely: 0,
      unknown: 0,
    };

    const urgencyDelta =
      (urgencyRank[String(b.urgency || "").toLowerCase()] || 0) -
      (urgencyRank[String(a.urgency || "").toLowerCase()] || 0);
    if (urgencyDelta !== 0) return urgencyDelta;

    const certaintyDelta =
      (certaintyRank[String(b.certainty || "").toLowerCase()] || 0) -
      (certaintyRank[String(a.certainty || "").toLowerCase()] || 0);
    if (certaintyDelta !== 0) return certaintyDelta;

    return new Date(a.expires || "").getTime() - new Date(b.expires || "").getTime();
  });
}

export function dedupeArea(areaDesc: string) {
  const parts = areaDesc
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length <= 2) return areaDesc;
  return `${parts.slice(0, 2).join(", ")} +${parts.length - 2} more`;
}

export function heroAreaLabel(alert: AlertItem) {
  const first = alert.areaDesc?.split(";")[0]?.trim() || "Your Area";
  return first
    .replace(/\b(County|Parish|Area)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function heroThreats(alert: AlertItem) {
  const text = `${alert.headline || ""} ${alert.description || ""}`.toLowerCase();
  const threats: string[] = [];

  if (text.includes("minor flooding")) threats.push("Minor Flooding");
  if (text.includes("flood stage")) threats.push("Near Flood Stage");
  if (text.includes("river is expected to rise")) threats.push("River Rising");
  if (text.includes("wind")) threats.push("70 MPH Winds");
  if (text.includes("hail")) threats.push("Large Hail");
  if (text.includes("flood")) threats.push("Flooding");
  if (text.includes("tornado")) threats.push("Rotation Possible");

  if (threats.length === 0) threats.push(alert.event);
  return threats.slice(0, 3);
}

export function getAlertCTA(event: string) {
  const e = event.toLowerCase();

  if (e.includes("tornado")) return "TAKE COVER NOW";
  if (e.includes("severe thunderstorm")) return "MOVE INDOORS";
  if (e.includes("flash flood")) return "AVOID FLOODED AREAS";
  if (e.includes("flood")) return "MOVE TO HIGHER GROUND";
  if (e.includes("winter")) return "AVOID TRAVEL";
  if (e.includes("heat")) return "STAY COOL";
  if (e.includes("fire")) return "EVACUATE IF ADVISED";

  return "STAY ALERT";
}

export function getAlertColor(event: string) {
  const e = event.toLowerCase();

  if (e.includes("warning")) return "red";
  if (e.includes("watch")) return "orange";
  if (e.includes("advisory")) return "yellow";
  if (e.includes("statement")) return "blue";

  return "red";
}

export function getAlertBackground(event?: string): string {
  switch (getHeroVariant(event)) {
    case "tornado":
      return "linear-gradient(135deg, rgba(90,20,20,0.72), rgba(20,20,20,0.78))";

    case "thunderstorm":
      return "linear-gradient(135deg, rgba(30,64,175,0.72), rgba(15,23,42,0.82))";

    case "flood":
      return "linear-gradient(135deg, rgba(8,47,73,0.70), rgba(3,105,161,0.70))";

    case "winter":
    case "ice":
      return "linear-gradient(135deg, rgba(71,85,105,0.66), rgba(148,163,184,0.58))";

    case "wind":
      return "linear-gradient(135deg, rgba(55,65,81,0.70), rgba(107,114,128,0.62))";

    case "marine":
      return "linear-gradient(135deg, rgba(2,132,199,0.70), rgba(3,37,65,0.80))";

    case "fog":
      return "linear-gradient(135deg, rgba(100,116,139,0.72), rgba(148,163,184,0.60))";

    case "heat":
      return "linear-gradient(135deg, rgba(180,83,9,0.70), rgba(239,68,68,0.64))";

    case "cold":
      return "linear-gradient(135deg, rgba(30,64,175,0.68), rgba(56,189,248,0.52))";

    case "fire":
      return "linear-gradient(135deg, rgba(153,27,27,0.72), rgba(234,88,12,0.60))";

    default:
      return "linear-gradient(135deg, rgba(15,23,42,0.72), rgba(51,65,85,0.64))";
  }
}

export function getHeroVariant(event?: string): HeroVariant {
  const text = String(event || "").toLowerCase();

  if (text.includes("tornado")) return "tornado";

  if (
    text.includes("thunderstorm") ||
    text.includes("storm") ||
    text.includes("lightning")
  ) {
    return "thunderstorm";
  }

  if (
    text.includes("flood") ||
    text.includes("flash flood") ||
    text.includes("coastal flood") ||
    text.includes("high surf")
  ) {
    return "flood";
  }

  if (
    text.includes("freezing rain") ||
    text.includes("ice storm") ||
    text.includes("icy") ||
    text.includes("glaze")
  ) {
    return "ice";
  }

  if (
    text.includes("winter") ||
    text.includes("snow") ||
    text.includes("blizzard") ||
    text.includes("sleet") ||
    text.includes("wind chill")
  ) {
    return "winter";
  }

  // wind (expanded marine coverage)
  // marine / ocean conditions (detect first)
  if (
    text.includes("hazardous seas") ||
    text.includes("small craft") ||
    text.includes("gale warning") ||
    (text.includes("storm warning") && text.includes("marine"))
  ) {
    return "marine";
  }

  // wind (expanded coverage)
  if (
    text.includes("wind advisory") ||
    text.includes("high wind") ||
    text.includes("strong wind") ||
    text.includes("gust") ||
    text.includes("gale") ||
    text.includes("storm warning") || // marine storm warning
    text.includes("hazardous seas") ||
    text.includes("small craft")
  ) {
    return "wind";
  }

  if (
    text.includes("fog") ||
    text.includes("dense fog") ||
    text.includes("smoke") ||
    text.includes("haze")
  ) {
    return "fog";
  }

  if (
    text.includes("heat advisory") ||
    text.includes("excessive heat") ||
    text.includes("heat")
  ) {
    return "heat";
  }

  if (
    text.includes("extreme cold") ||
    text.includes("cold weather") ||
    text.includes("hard freeze") ||
    text.includes("freeze warning") ||
    text.includes("freeze watch") ||
    text.includes("frost advisory") ||
    text.includes("cold")
  ) {
    return "cold";
  }

  if (
    text.includes("red flag") ||
    text.includes("fire weather") ||
    text.includes("fire danger")
  ) {
    return "fire";
  }

  return "default";
}

export function getHeroVariantBackgroundImage(event?: string): string | null {
  switch (getHeroVariant(event)) {
    case "tornado":
      return "/images/website/tornado.jpg";

    case "thunderstorm":
      return "/images/website/thunderstorm.jpg";

    case "flood":
      return "/images/website/flood.jpg";

    case "winter":
      return "/images/website/winter.jpg";

    case "ice":
      return "/images/website/freezing-rain.jpg";

    case "wind":
      return "/images/website/wind.jpg";

    case "marine":
      return "/images/website/hazardous-seas-warning.jpg";

    case "fog":
      return "/images/website/dense-fog.jpg";

    case "heat":
      return "/images/website/extreme-heat.jpg";

    case "cold":
      return "/images/website/extreme-cold.jpg";

    case "fire":
      return "/images/website/fire.jpg";

    default:
      return null;
  }
}

export function getHeroVariantBackgroundImageIfExists(event?: string): string | null {
  return getHeroVariantBackgroundImage(event);
}

export function smallAlertTone(event?: string): string {
  switch (getHeroVariant(event)) {
    case "tornado":
      return "from-red-950 to-slate-950";
    case "thunderstorm":
      return "from-blue-900 to-slate-950";
    case "flood":
      return "from-sky-900 to-blue-950";
    case "winter":
    case "ice":
      return "from-slate-500 to-slate-900";
    case "wind":
      return "from-slate-700 to-slate-950";
    case "marine":
      return "from-cyan-700 to-blue-950";
    case "fog":
      return "from-slate-400 to-slate-800";
    case "heat":
      return "from-orange-700 to-red-900";
    case "cold":
      return "from-blue-700 to-cyan-900";
    case "fire":
      return "from-red-800 to-orange-900";
    default:
      return "from-slate-800 to-slate-950";
  }
}


export function getHeroVariantStyles(variant: HeroVariant) {
  switch (variant) {
    case "tornado":
      return {
        wrapper: "border-red-500/30 bg-[#140608]",
        topBar: "bg-red-700",
        title: "text-[2.2rem] leading-[0.92]",
        subtitle: "text-white/95",
        cta: "bg-white text-red-700 hover:bg-red-50",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
    case "thunderstorm":
      return {
        wrapper: "border-blue-500/30 bg-[#0f1d3a]",
        topBar: "bg-blue-700",
        title: "text-[2.2rem] leading-[0.92]",
        subtitle: "text-white/95",
        cta: "bg-blue-600 text-white hover:bg-blue-500",
        details: "bg-cyan-500 hover:bg-cyan-400 text-white",
      };
    case "flood":
      return {
        wrapper: "border-sky-500/25 bg-[#0a1b2f]",
        topBar: "bg-blue-600",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-white/95",
        cta: "bg-slate-950/55 text-white hover:bg-slate-900/70",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
    case "winter":
    case "ice":
      return {
        wrapper: "border-blue-200/25 bg-[#0c1520]",
        topBar: "bg-blue-700",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-slate-100",
        cta: "bg-white/90 text-slate-900 hover:bg-white",
        details: "bg-sky-600 hover:bg-sky-500 text-white",
      };
    case "wind":
      return {
        wrapper: "border-slate-500/25 bg-[#1a202e]",
        topBar: "bg-slate-700",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-slate-200",
        cta: "bg-slate-900/80 text-white hover:bg-slate-800",
        details: "bg-cyan-600 hover:bg-cyan-500 text-white",
      };
    case "marine":
      return {
        wrapper: "border-cyan-500/30 bg-[#052139]",
        topBar: "bg-cyan-700",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-cyan-100",
        cta: "bg-cyan-600 text-white hover:bg-cyan-500",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
    case "fog":
      return {
        wrapper: "border-slate-400/25 bg-[#1f2937]",
        topBar: "bg-slate-600",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-slate-200",
        cta: "bg-slate-800/80 text-white hover:bg-slate-700",
        details: "bg-slate-600 hover:bg-slate-500 text-white",
      };
    case "heat":
      return {
        wrapper: "border-orange-600/25 bg-[#2a100a]",
        topBar: "bg-orange-700",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-orange-100",
        cta: "bg-orange-500 text-white hover:bg-orange-400",
        details: "bg-red-600 hover:bg-red-500 text-white",
      };
    case "cold":
      return {
        wrapper: "border-blue-600/25 bg-[#0a1320]",
        topBar: "bg-blue-700",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-cyan-100",
        cta: "bg-blue-500 text-white hover:bg-blue-400",
        details: "bg-cyan-600 hover:bg-cyan-500 text-white",
      };
    case "fire":
      return {
        wrapper: "border-orange-400/25 bg-[#1a0d05]",
        topBar: "bg-orange-600",
        title: "text-[2.1rem] leading-[0.94]",
        subtitle: "text-orange-50",
        cta: "bg-white text-orange-700 hover:bg-orange-50",
        details: "bg-orange-500 hover:bg-orange-400 text-white",
      };
    default:
      return {
        wrapper: "border-red-500/25 bg-[#13090a]",
        topBar: "bg-red-600",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-white/95",
        cta: "bg-white text-red-700 hover:bg-red-50",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
  }
}

export function cleanSectionText(value?: string | null) {
  if (!value) return null;
  return value
    .replace(/^\s+|\s+$/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBulletSection(description: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\*\\s*${escaped}\\.{3}([\\s\\S]+?)(?=\\n\\n\\*\\s*[A-Z][A-Z\\s]+\\.{3}|$)`,
    "i"
  );
  const match = description.match(regex);
  return cleanSectionText(match?.[1] || null);
}

export function stripFloodIntro(description: string) {
  let text = description || "";
  text = text.replace(/^\.\.\.[\s\S]*?(?=\n\n\*\s*WHAT\.\.\.)/i, "");
  return text.trim();
}

export function parseAlertSections(alert: AlertItem) {
  const description = alert.description || "";
  const instruction = alert.instruction || "";

  const normalizedDescription = stripFloodIntro(description);

  const hazardMatch = normalizedDescription.match(/(?:^|\n)HAZARD\.*\s*([\s\S]+?)(?:\n\n|(?:^|\n)SOURCE|(?:^|\n)IMPACT|$)/i);
  const sourceMatch = normalizedDescription.match(/(?:^|\n)SOURCE\.*\s*([\s\S]+?)(?:\n\n|(?:^|\n)IMPACT|$)/i);
  const impactMatch = normalizedDescription.match(/(?:^|\n)IMPACT\.*\s*([\s\S]+?)(?:\n\n|$)/i);

  const what = extractBulletSection(normalizedDescription, "WHAT");
  const where = extractBulletSection(normalizedDescription, "WHERE");
  const when = extractBulletSection(normalizedDescription, "WHEN");
  const impacts = extractBulletSection(normalizedDescription, "IMPACTS");
  const additionalDetails = extractBulletSection(normalizedDescription, "ADDITIONAL DETAILS");

  const cleanedDescription = cleanSectionText(
    normalizedDescription.replace(/\n\n\*\s*(WHAT|WHERE|WHEN|IMPACTS|ADDITIONAL DETAILS)\.\.\.[\s\S]*?(?=(\n\n\*\s*[A-Z][A-Z\s]+\.\.\.)|$)/gi, "")
  );

  return {
    description: cleanedDescription,
    hazard: cleanSectionText(hazardMatch?.[1] || null),
    source: cleanSectionText(sourceMatch?.[1] || null),
    impact: cleanSectionText(impactMatch?.[1] || null),
    what,
    where,
    when,
    impacts,
    additionalDetails,
    instruction: cleanSectionText(instruction),
  };
}
