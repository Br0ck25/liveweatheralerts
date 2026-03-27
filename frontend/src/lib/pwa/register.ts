import { registerSW } from "virtual:pwa-register";

export const PWA_UPDATE_AVAILABLE_EVENT = "lwa:pwa-update-available";
export const PWA_OFFLINE_READY_EVENT = "lwa:pwa-offline-ready";

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null;

function dispatchWindowEvent(name: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name));
}

export function registerPwaServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh: () => {
      dispatchWindowEvent(PWA_UPDATE_AVAILABLE_EVENT);
    },
    onOfflineReady: () => {
      dispatchWindowEvent(PWA_OFFLINE_READY_EVENT);
    },
    onRegisterError: (error) => {
      console.error("PWA service worker registration failed.", error);
    }
  });
}

export async function applyPwaUpdate(): Promise<boolean> {
  if (!updateServiceWorker) {
    return false;
  }

  await updateServiceWorker(true);
  return true;
}
