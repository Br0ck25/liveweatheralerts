import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function openExternal(url?: string | null) {
  if (!url) return
  window.open(url, "_blank", "noopener,noreferrer")
}

export function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "start" })
}

export function formatRelative(value?: string | null) {
  if (!value) return "just now"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "recently"
  const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000))
  if (diffMin < 1) return "just now"
  if (diffMin === 1) return "1 min ago"
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  return `${diffHr} hr ago`
}
