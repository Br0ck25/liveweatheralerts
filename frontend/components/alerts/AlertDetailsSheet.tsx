"use client";

import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/utils";
import { AlertItem, parseAlertSections, heroAreaLabel } from "@/lib/alerts/helpers";
import { formatAlertDate, formatTimeLeft } from "@/lib/weather/formatters";

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
              <div className="text-xs font-black uppercase tracking-wide text-red-600">{alert.event}</div>
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
