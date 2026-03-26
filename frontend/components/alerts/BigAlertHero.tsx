"use client";

import { Button } from "@/components/ui/button";
import { TriangleAlert } from "lucide-react";
import { getAlertCTA, getHeroVariant, getHeroVariantStyles, getAlertBackground, getHeroVariantBackgroundImageIfExists, heroAreaLabel, heroThreats, AlertItem } from "@/lib/alerts/helpers";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/weather/formatters";

export default function BigAlertHero({
  alert,
  etaText,
  ctaText,
  onPrimaryAction,
  onViewDetails,
}: {
  alert: AlertItem;
  etaText?: string | null;
  ctaText?: string;
  onPrimaryAction: (alert: AlertItem) => void;
  onViewDetails: (alert: AlertItem) => void;
}) {
  const area = heroAreaLabel(alert);
  const threats = heroThreats(alert);
  const variant = getHeroVariant(alert.event);
  const styles = getHeroVariantStyles(variant);
  const backgroundImage = getHeroVariantBackgroundImageIfExists(alert.event);

  return (
    <div className={cn("overflow-hidden rounded-[22px] border shadow-2xl", styles.wrapper)}>
      <div className={cn("px-3 py-2 text-sm font-black uppercase tracking-wide text-white", styles.topBar)}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4" />
          {alert.event}
        </div>
      </div>

      <div className="relative min-h-[250px] overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: backgroundImage
              ? `url(${backgroundImage})`
              : getAlertBackground(alert.event),
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }}
        />

        {variant === "tornado" && (
          <>
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.05),rgba(0,0,0,0.55))]" />
            <div className="absolute right-16 top-8 h-28 w-[2px] bg-white/85 blur-[1px]" />
            <div className="absolute right-20 top-20 h-20 w-[2px] rotate-[22deg] bg-white/70 blur-[1px]" />
            <div className="absolute right-28 top-16 h-16 w-[2px] -rotate-[25deg] bg-white/55 blur-[1px]" />
            <div className="absolute right-10 top-10 h-24 w-24 rounded-full bg-white/20 blur-2xl" />
          </>
        )}

        {variant === "flood" && (
          <>
            <div className="absolute inset-0 opacity-20 [background:radial-gradient(circle_at_center,rgba(255,255,255,0.2)_1px,transparent_1px)] [background-size:12px_12px]" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(80,160,255,0.18))]" />
          </>
        )}

        {variant === "winter" && (
          <>
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(rgba(255,255,255,0.8)_1px,transparent_1px)] [background-size:14px_14px]" />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.08))]" />
          </>
        )}

        {variant === "fire" && (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_30%,rgba(255,190,60,0.25),transparent_14%)]" />
            <div className="absolute right-10 top-10 h-20 w-20 rounded-full bg-orange-300/25 blur-2xl" />
            <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(180deg,transparent,rgba(255,120,0,0.16))]" />
          </>
        )}

        {variant === "default" && (
          <div className="absolute inset-0 opacity-20 animate-pulse bg-[radial-gradient(circle_at_80%_30%,rgba(255,255,255,0.15),transparent_20%)]" />
        )}

        <div className="relative flex min-h-[250px] flex-col justify-between p-4">
          <div>
            <div className={cn("text-3xl font-black tracking-tight text-white", styles.title)}>{area}</div>
            <div className="mt-1 text-sm font-bold text-white/90">
              {alert.event}
              {threats.length > 0 ? ` • ${threats.join(" • ")}` : ""}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4 text-sm font-bold text-white">
              {threats.map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-white/90" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => onPrimaryAction(alert)}
              className={cn("mt-4 inline-flex rounded-lg px-3 py-2 text-sm font-black text-white shadow-lg hover:bg-black/40", styles.cta)}
            >
              {ctaText || getAlertCTA(alert.event)}
            </button>
          </div>

          {etaText && (
            <div
              className={cn(
                "mt-2 text-xs font-bold",
                etaText.includes("Arriving")
                  ? "text-red-200"
                  : etaText.includes("1 hour")
                  ? "text-yellow-200"
                  : "text-white/80"
              )}
            >
              {etaText}
            </div>
          )}

          <div className="mt-4 flex items-end justify-between gap-3">
            <div className="rounded-lg bg-black/35 px-3 py-2 text-sm font-bold text-white">Until {formatTime(alert.expires)}</div>
            <Button className={cn("h-10 rounded-lg px-5 font-black", styles.details)} onClick={() => onViewDetails(alert)}>
              View Details
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
