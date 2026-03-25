const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
const PUSH_PREFS_KEY = "lwa-push-prefs-v1";

export type PushAlertTypes = {
  warnings: boolean;
  watches: boolean;
  advisories: boolean;
  statements: boolean;
};

export type QuietHours = {
  enabled: boolean;
  start: string; // "22:00"
  end: string;   // "06:00"
};

export type PushPreferences = {
  stateCode: string;
  deliveryScope: "state" | "county";
  countyName?: string | null;
  countyFips?: string | null;
  alertTypes: PushAlertTypes;
  quietHours: QuietHours;
};

export type PushStatus = {
  enabled: boolean;
  subscription: PushSubscription | null;
  prefs: PushPreferences | null;
};

const DEFAULT_ALERT_TYPES: PushAlertTypes = {
  warnings: true,
  watches: true,
  advisories: false,
  statements: true,
};

const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  start: "22:00",
  end: "06:00",
};

export function buildDefaultPushPreferences(stateCode: string): PushPreferences {
  return {
    stateCode,
    deliveryScope: "state",
    countyName: null,
    countyFips: null,
    alertTypes: DEFAULT_ALERT_TYPES,
    quietHours: DEFAULT_QUIET_HOURS,
  };
}

export function readStoredPushPreferences(): PushPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PUSH_PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PushPreferences;
  } catch {
    return null;
  }
}

function writeStoredPushPreferences(prefs: PushPreferences | null) {
  if (typeof window === "undefined") return;
  if (!prefs) {
    localStorage.removeItem(PUSH_PREFS_KEY);
    return;
  }
  localStorage.setItem(PUSH_PREFS_KEY, JSON.stringify(prefs));
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!("serviceWorker" in navigator)) {
    return { enabled: false, subscription: null, prefs: readStoredPushPreferences() };
  }

  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    return { enabled: false, subscription: null, prefs: readStoredPushPreferences() };
  }

  const sub = await reg.pushManager.getSubscription();
  return {
    enabled: !!sub,
    subscription: sub,
    prefs: readStoredPushPreferences(),
  };
}

export async function subscribeToPush(prefs: PushPreferences) {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers not supported");
  }

  if (!("PushManager" in window)) {
    throw new Error("Push messaging is not supported in this browser.");
  }

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission denied");
  }

  const keyRes = await fetch(`${API_BASE}/api/push/public-key`, { cache: "no-store" });
  const keyText = await keyRes.text();

  if (!keyRes.ok) {
    throw new Error(`Public key request failed: ${keyRes.status} ${keyText}`);
  }

  let publicKey = "";
  try {
    publicKey = JSON.parse(keyText).publicKey;
  } catch {
    throw new Error("Push public key endpoint did not return valid JSON.");
  }

  if (!publicKey) {
    throw new Error("Push public key missing from server response.");
  }

  const existingSub = await reg.pushManager.getSubscription();
  const subscription =
    existingSub ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const subRes = await fetch(`${API_BASE}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subscription,
      stateCode: prefs.stateCode,
      prefs,
    }),
  });

  const subText = await subRes.text();
  if (!subRes.ok) {
    throw new Error(`Subscribe failed: ${subRes.status} ${subText}`);
  }

  writeStoredPushPreferences(prefs);
  return true;
}

export async function updatePushPreferences(prefs: PushPreferences) {
  const status = await getPushStatus();
  if (!status.subscription) {
    throw new Error("No active push subscription found.");
  }

  const res = await fetch(`${API_BASE}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subscription: status.subscription,
      stateCode: prefs.stateCode,
      prefs,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Update failed: ${res.status} ${text}`);
  }

  writeStoredPushPreferences(prefs);
  return true;
}

export async function unsubscribeFromPush() {
  if (!("serviceWorker" in navigator)) return false;

  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    writeStoredPushPreferences(null);
    return false;
  }

  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    writeStoredPushPreferences(null);
    return false;
  }

  const res = await fetch(`${API_BASE}/api/push/unsubscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: sub.endpoint,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Unsubscribe failed: ${res.status} ${text}`);
  }

  await sub.unsubscribe();
  writeStoredPushPreferences(null);
  return true;
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
