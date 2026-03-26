"use client";

import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotificationPrompt({
  locationLabel,
  busy = false,
  onEnable,
  onNotNow,
}: {
  locationLabel: string;
  busy?: boolean;
  onEnable: () => void;
  onNotNow: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/75 p-4">
      <div className="w-full max-w-sm rounded-[28px] border border-white/10 bg-slate-900 p-5 text-white shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/20 text-red-300">
          <Bell className="h-6 w-6" />
        </div>

        <h2 className="text-xl font-bold">Turn on alerts for {locationLabel}?</h2>

        <p className="mt-2 text-sm text-slate-300">
          Get important weather alerts for your area, including severe warnings and dangerous conditions.
        </p>

        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-800/70 p-3 text-sm text-slate-200">
          <div>• Severe weather warnings</div>
          <div>• Important alert updates</div>
          <div>• You can change this anytime in More</div>
        </div>

        <div className="mt-5 space-y-3">
          <Button
            className="h-11 w-full rounded-2xl bg-blue-600 text-white hover:bg-blue-500"
            onClick={onEnable}
            disabled={busy}
          >
            {busy ? "Enabling..." : "Enable Alerts"}
          </Button>

          <Button
            variant="outline"
            className="h-11 w-full rounded-2xl border-white/15 bg-transparent text-white hover:bg-white/5"
            onClick={onNotNow}
            disabled={busy}
          >
            Not Now
          </Button>
        </div>

        <p className="mt-3 text-center text-xs text-slate-400">
          You can change alert settings later in the More tab.
        </p>
      </div>
    </div>
  );
}
