import type {
  PushPublicKeyPayload,
  PushSubscribePayload,
  PushSubscribeRequest,
  PushTestPayload,
  PushUnsubscribePayload
} from "../../types";
import { requestJson } from "./http";

export async function getPushPublicKey(
  signal?: AbortSignal
): Promise<PushPublicKeyPayload> {
  return await requestJson<PushPublicKeyPayload>("/api/push/public-key", {
    signal,
    fallbackError: "Push notifications are unavailable right now."
  });
}

export async function subscribePush(
  body: PushSubscribeRequest,
  signal?: AbortSignal
): Promise<PushSubscribePayload> {
  return await requestJson<PushSubscribePayload>("/api/push/subscribe", {
    method: "POST",
    body,
    signal,
    fallbackError: "Unable to subscribe to push notifications."
  });
}

export async function unsubscribePush(
  endpoint: string,
  signal?: AbortSignal
): Promise<PushUnsubscribePayload> {
  return await requestJson<PushUnsubscribePayload>("/api/push/unsubscribe", {
    method: "POST",
    body: {
      endpoint
    },
    signal,
    fallbackError: "Unable to unsubscribe from push notifications."
  });
}

export async function sendTestPush(
  body: PushSubscribeRequest,
  signal?: AbortSignal
): Promise<PushTestPayload> {
  return await requestJson<PushTestPayload>("/api/push/test", {
    method: "POST",
    body,
    signal,
    fallbackError: "Unable to send a test notification right now."
  });
}
