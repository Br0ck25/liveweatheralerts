"use client";

import { Card, CardContent } from "@/components/ui/card";
import { ShieldAlert, ChevronRight } from "lucide-react";
import { dedupeArea } from "@/lib/alerts/helpers";
import { AlertItem } from "@/lib/alerts/helpers";

export default function AlertHeadlineList({
  alerts,
  onSelectAlert,
}: {
  alerts: AlertItem[];
  onSelectAlert: (alert: AlertItem) => void;
}) {
  return (
    <Card className="rounded-[28px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <CardContent className="p-4">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase tracking-wide">
          <ShieldAlert className="h-5 w-5 text-red-400" />
          Alert Headlines
        </div>

        <div className="space-y-3">
          {alerts.slice(0, 4).map((alert) => (
            <button
              key={alert.id}
              type="button"
              onClick={() => onSelectAlert(alert)}
              className="flex w-full items-center justify-between rounded-[20px] border border-red-500/20 bg-gradient-to-r from-red-700 to-red-600 px-4 py-3 text-left shadow-lg"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-black uppercase tracking-wide text-white">{alert.event}</div>
                <div className="truncate text-sm text-red-50">{alert.headline || dedupeArea(alert.areaDesc)}</div>
              </div>
              <ChevronRight className="ml-3 h-5 w-5 shrink-0 text-white" />
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
