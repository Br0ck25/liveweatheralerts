"use client";

import { Button } from "@/components/ui/button";

type AlertItem = {
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

function openExternal(url?: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function formatAlertDate(value?: string) {
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

function formatTimeLeft(expires?: string, whenText?: string | null) {
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

function cleanSectionText(value?: string | null) {
  if (!value) return null;
  return value
    .replace(/^\s+|\s+$/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBulletSection(description: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `\\*\\s*${escaped}\\.{3}([\\s\\S]+?)(?=\\n\\n\\*\\s*[A-Z][A-Z\\s]+\\.{3}|$)`,
    "i"
  );
  const match = description.match(regex);
  return cleanSectionText(match?.[1] || null);
}

function stripFloodIntro(description: string) {
  let text = description || "";

  text = text.replace(/^\.\.\.[\s\S]*?(?=\n\n\*\s*WHAT\.\.\.)/i, "");

  return text.trim();
}

function parseAlertSections(alert: AlertItem) {
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

function heroAreaLabel(alert: AlertItem) {
  const first = alert.areaDesc?.split(";")[0]?.trim() || "Your Area";
  return first.replace(/\b(County|Parish|Area)\b/gi, "").replace(/\s{2,}/g, " ").trim();
}

export default function AlertDetailsSheet({
  alert,
  onClose,
}: {
  alert: AlertItem;
  onClose: () => void;
}) {
  const sections = parseAlertSections(alert);
  const primaryRiverPoint = sections.where?.trim() || null;

  return (
    <div className="fixed inset-0 z-[120] bg-slate-950/70 backdrop-blur-sm">
      <div className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-[28px] border border-white/10 bg-white text-slate-900 shadow-2xl">
        <div className="max-h-[85vh] overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-black uppercase tracking-wide text-red-600">
                {alert.event}
              </div>
              <div className="mt-1 text-2xl font-black leading-tight">{heroAreaLabel(alert)}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
            >
              Close
            </button>
          </div>

          {primaryRiverPoint ? (
            <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <div className="font-black uppercase text-slate-500">Primary River Point</div>
              <div className="mt-1 font-medium text-slate-900">{primaryRiverPoint}</div>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <div>
              <div className="font-black uppercase text-slate-500">Issued</div>
              <div className="mt-1 font-medium">{formatAlertDate(alert.sent)}</div>
            </div>
            <div>
              <div className="font-black uppercase text-slate-500">Expires</div>
              <div className="mt-1 font-medium">{formatAlertDate(alert.expires)}</div>
            </div>
            <div>
              <div className="font-black uppercase text-slate-500">Time Left</div>
              <div className="mt-1 font-medium">{formatTimeLeft(alert.expires, sections.when)}</div>
            </div>
          </div>

          <div className="mt-5 space-y-4 text-sm leading-6">
            <div>
              <div className="font-black uppercase text-slate-500">Affected Areas</div>
              <div className="mt-1">{alert.areaDesc || "—"}</div>
            </div>

            {sections.description &&
            !(sections.what || sections.where || sections.when || sections.impacts || sections.additionalDetails) ? (
              <div>
                <div className="font-black uppercase text-slate-500">Description</div>
                <div className="mt-1 whitespace-pre-line">{sections.description}</div>
              </div>
            ) : null}

            {sections.what ? (
              <div>
                <div className="font-black uppercase text-slate-500">What</div>
                <div className="mt-1 whitespace-pre-line">{sections.what}</div>
              </div>
            ) : null}

            {sections.when ? (
              <div>
                <div className="font-black uppercase text-slate-500">When</div>
                <div className="mt-1 whitespace-pre-line">{sections.when}</div>
              </div>
            ) : null}

            {sections.impacts ? (
              <div>
                <div className="font-black uppercase text-slate-500">Impacts</div>
                <div className="mt-1 whitespace-pre-line">{sections.impacts}</div>
              </div>
            ) : null}

            {sections.additionalDetails ? (
              <div>
                <div className="font-black uppercase text-slate-500">Additional Details</div>
                <div className="mt-1 whitespace-pre-line">{sections.additionalDetails}</div>
              </div>
            ) : null}

            {sections.hazard ? (
              <div>
                <div className="font-black uppercase text-slate-500">Hazard</div>
                <div className="mt-1 whitespace-pre-line">{sections.hazard}</div>
              </div>
            ) : null}

            {sections.source ? (
              <div>
                <div className="font-black uppercase text-slate-500">Source</div>
                <div className="mt-1 whitespace-pre-line">{sections.source}</div>
              </div>
            ) : null}

            {sections.impact && !sections.impacts ? (
              <div>
                <div className="font-black uppercase text-slate-500">Impact</div>
                <div className="mt-1 whitespace-pre-line">{sections.impact}</div>
              </div>
            ) : null}

            {sections.instruction ? (
              <div>
                <div className="font-black uppercase text-slate-500">Instructions</div>
                <div className="mt-1 whitespace-pre-line">{sections.instruction}</div>
              </div>
            ) : null}
          </div>

          <div className="mt-6">
            <Button
              className="w-full rounded-2xl bg-blue-600 font-bold text-white hover:bg-blue-500"
              onClick={() => openExternal(alert.nwsUrl)}
            >
              View official NWS alert
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
