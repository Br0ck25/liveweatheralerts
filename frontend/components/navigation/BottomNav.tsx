"use client";

import { cn } from "@/lib/utils";
import { Bell, Home, Menu, Radar, Sun } from "lucide-react";

type BottomNavTabKey = "home" | "forecast" | "radar" | "alerts" | "more";

export default function BottomNav({
  alertCount = 0,
  activeTab,
  onChangeTab,
}: {
  alertCount?: number;
  activeTab: BottomNavTabKey;
  onChangeTab: (tab: BottomNavTabKey) => void;
}) {
  type BottomNavTab = {
    key: BottomNavTabKey;
    label: string;
    icon: typeof Home;
    badge?: number;
  };

  const tabs: BottomNavTab[] = [
    { key: "home", label: "Home", icon: Home },
    { key: "forecast", label: "Forecast", icon: Sun },
    { key: "radar", label: "Radar", icon: Radar },
    { key: "alerts", label: "Alerts", icon: Bell, badge: alertCount },
    { key: "more", label: "More", icon: Menu },
  ];

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md px-3 pb-3">
      <div className="rounded-[26px] border border-white/10 bg-slate-950/90 px-2 py-2 shadow-2xl backdrop-blur-xl">
        <div className="grid grid-cols-5 gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
                    navigator.vibrate(10);
                  }
                  onChangeTab(tab.key);
                }}
                className={cn(
                  "group relative inline-flex h-11 w-full flex-col items-center justify-center rounded-2xl text-[10px] font-extrabold uppercase tracking-wider transition-all duration-200",
                  isActive
                    ? "bg-blue-500/20 text-white shadow-[0_0_12px_rgba(59,130,246,0.35)] border border-blue-400/30"
                    : "bg-slate-900/40 text-slate-400 hover:bg-white/10 hover:text-white",
                  "active:scale-95"
                )}
              >
                {isActive && (
                  <span className="absolute inset-0 rounded-2xl bg-blue-500/10 blur-md" />
                )}
                <Icon
                  className={cn(
                    "h-5 w-5 transition-all duration-200",
                    isActive && "scale-110 drop-shadow-[0_0_6px_rgba(59,130,246,0.6)]"
                  )}
                />
                <span className={cn(isActive && "text-white")}>{tab.label}</span>
                {tab.badge ? (
                  <span className="absolute -right-2 -top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-black text-white">
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
