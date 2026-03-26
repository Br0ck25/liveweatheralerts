// shared alert data type
export type AlertItem = {
  id: string;
  stateCode: string;
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

export function getAlertBackground(event: string) {
  const e = event.toLowerCase();
  const isWarning = e.includes("warning");
  const isWatch = e.includes("watch");
  const isAdvisory = e.includes("advisory");

  if (isWarning) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,120,120,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,0,0,0.25), rgba(40,0,0,0.9)),
      linear-gradient(120deg, #5a0000 0%, #9a0000 40%, #390000 100%)
    `;
  }

  if (isWatch) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,180,0,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,60,0,0.3), rgba(60,30,0,0.9)),
      linear-gradient(120deg, #ff8c00 0%, #ff6a00 40%, #5a1a00 100%)
    `;
  }

  if (isAdvisory) {
    return `
      radial-gradient(circle at 70% 40%, rgba(255,230,120,0.35), transparent 20%),
      linear-gradient(180deg, rgba(120,100,0,0.3), rgba(60,50,0,0.9)),
      linear-gradient(120deg, #eab308 0%, #facc15 40%, #a16207 100%)
    `;
  }

  return `
    radial-gradient(circle at 70% 40%, rgba(120,200,255,0.25), transparent 20%),
    linear-gradient(180deg, rgba(0,40,80,0.4), rgba(0,20,50,0.9)),
    linear-gradient(120deg, #0b3a5c 0%, #1f6fa5 40%, #09263f 100%)
  `;
}

export function getHeroVariant(event: string): "tornado" | "flood" | "winter" | "fire" | "thunderstorm" | "dense-fog" | "extreme-cold" | "extreme-heat" | "freezing-rain" | "wind" | "default" {
  const e = event.toLowerCase();

  if (e.includes("tornado")) return "tornado";
  if (e.includes("severe thunderstorm") || e.includes("thunderstorm")) return "thunderstorm";
  if (e.includes("flood")) return "flood";
  if (e.includes("freezing rain")) return "freezing-rain";
  if (e.includes("dense fog") || e.includes("fog")) return "dense-fog";
  if (e.includes("extreme cold") || e.includes("cold")) return "extreme-cold";
  if (e.includes("extreme heat") || e.includes("heat")) return "extreme-heat";
  if (e.includes("winter") || e.includes("snow") || e.includes("ice") || e.includes("blizzard")) return "winter";
  if (e.includes("wind") || e.includes("high wind")) return "wind";
  if (e.includes("fire") || e.includes("red flag") || e.includes("smoke")) return "fire";

  return "default";
}

export function getHeroVariantBackgroundImage(event: string): string | null {
  const variant = getHeroVariant(event);

  switch (variant) {
    case "tornado":
      return "/images/website/tornado.jpg";
    case "thunderstorm":
      return "/images/website/thunderstorm.jpg";
    case "flood":
      return "/images/website/flood.jpg";
    case "freezing-rain":
      return "/images/website/freezing-rain.jpg";
    case "dense-fog":
      return "/images/website/dense-fog.jpg";
    case "extreme-cold":
      return "/images/website/extreme-cold.jpg";
    case "extreme-heat":
      return "/images/website/extreme-heat.jpg";
    case "wind":
      return "/images/website/wind.jpg";
    case "winter":
      return "/images/website/winter.jpg";
    case "fire":
      return "/images/website/fire.jpg";
    default:
      return "/images/website/aaaadefault.jpg";
  }
}

export function getHeroVariantBackgroundImageIfExists(event: string): string | null {
  const path = getHeroVariantBackgroundImage(event);
  // fallback support for missing files
  // (in this environment we cannot test filesystem at runtime in browser,
  // so keep this as the declarative API, and make BigAlertHero handle null.)
  return path || null;
}

export function getHeroVariantStyles(variant: ReturnType<typeof getHeroVariant>) {
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
    case "flood":
      return {
        wrapper: "border-red-500/25 bg-[#12090a]",
        topBar: "bg-red-600",
        title: "text-[2.05rem] leading-[0.95]",
        subtitle: "text-white/95",
        cta: "bg-slate-950/55 text-white hover:bg-slate-900/70",
        details: "bg-blue-600 hover:bg-blue-500 text-white",
      };
    case "winter":
      return {
        wrapper: "border-blue-200/25 bg-[#0c1520]",
        topBar: "bg-blue-700",
        title: "text-[2rem] leading-[0.95]",
        subtitle: "text-slate-100",
        cta: "bg-white/90 text-slate-900 hover:bg-white",
        details: "bg-sky-600 hover:bg-sky-500 text-white",
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

export function smallAlertTone(event: string) {
  const level = getAlertColor(event);
  if (level === "red") return "from-red-600 to-red-800";
  if (level === "orange") return "from-orange-500 to-orange-700";
  if (level === "yellow") return "from-yellow-400 to-yellow-600";
  if (level === "blue") return "from-blue-500 to-blue-700";
  return "from-red-600 to-red-800";
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
