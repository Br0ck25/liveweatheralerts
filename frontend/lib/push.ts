const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export async function subscribeToPush(stateCode: string) {
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

  const keyRes = await fetch(`${API_BASE}/api/push/public-key`, {
    cache: "no-store",
  });

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

  try {
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
        stateCode,
      }),
    });

    const subText = await subRes.text();
    if (!subRes.ok) {
      throw new Error(`Subscribe failed: ${subRes.status} ${subText}`);
    }

    return true;
  } catch (err) {
    console.error("Push subscribe failure:", err);
    const message =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : "Unknown push subscription error";
    throw new Error(message);
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
