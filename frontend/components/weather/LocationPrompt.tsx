"use client";

import React, { useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LocationPrompt({
  onUseGeo,
  onUseZip,
  defaultToZip = false,
}: {
  onUseGeo: () => void;
  onUseZip: (zip: string) => void;
  defaultToZip?: boolean;
}) {
  const [zip, setZip] = useState("");
  const [showZip, setShowZip] = useState(defaultToZip);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-4">
      <div className="w-full max-w-sm rounded-[28px] border border-white/10 bg-slate-900 p-5 text-white shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/20 text-blue-300">
          <MapPin className="h-6 w-6" />
        </div>

        <h2 className="text-xl font-bold">Enable location for local weather alerts?</h2>
        <p className="mt-2 text-sm text-slate-300">
          Use your location for nearby alerts, local conditions, and faster radar targeting.
        </p>

        {!showZip ? (
          <div className="mt-5 space-y-3">
            <Button
              className="h-11 w-full rounded-2xl bg-blue-600 text-white hover:bg-blue-500"
              onClick={onUseGeo}
            >
              Allow Location
            </Button>

            <Button
              variant="outline"
              className="h-11 w-full rounded-2xl border-white/15 bg-transparent text-white hover:bg-white/5"
              onClick={() => setShowZip(true)}
            >
              Enter ZIP Code Instead
            </Button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <Input
              inputMode="numeric"
              maxLength={5}
              placeholder="Enter ZIP Code"
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="h-11 rounded-2xl border-white/10 bg-slate-800 text-white placeholder:text-slate-400"
            />

            <Button
              className="h-11 w-full rounded-2xl bg-blue-600 text-white hover:bg-blue-500"
              onClick={() => zip.length === 5 && onUseZip(zip)}
              disabled={zip.length !== 5}
            >
              Save ZIP Code
            </Button>

            <button
              type="button"
              className="w-full text-sm text-slate-400"
              onClick={() => setShowZip(false)}
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
