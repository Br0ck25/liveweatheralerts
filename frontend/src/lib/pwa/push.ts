export type BrowserPermissionState =
  | NotificationPermission
  | "unsupported";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function isPushSupported(): boolean {
  if (!hasWindow()) return false;
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getNotificationPermissionStatus(): BrowserPermissionState {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<BrowserPermissionState> {
  if (!isPushSupported()) return "unsupported";
  return await Notification.requestPermission();
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return buffer;
}

async function getReadyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const registration = await getReadyRegistration();
  if (!registration) return null;
  return await registration.pushManager.getSubscription();
}

export async function subscribeBrowserPush(
  vapidPublicKey: string
): Promise<PushSubscription> {
  const registration = await getReadyRegistration();
  if (!registration) {
    throw new Error("Service worker is not ready yet.");
  }

  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey)
  });
}

export async function unsubscribeBrowserPush(
  subscription: PushSubscription
): Promise<boolean> {
  return await subscription.unsubscribe();
}
