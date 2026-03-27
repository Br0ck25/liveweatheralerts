import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushScope, SavedPlace } from "../../../types";
import { usePushNotifications } from "./usePushNotifications";

const pushApiMocks = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  sendTestPush: vi.fn()
}));

const pushBrowserMocks = vi.hoisted(() => ({
  isPushSupported: vi.fn(),
  getNotificationPermissionStatus: vi.fn(),
  requestNotificationPermission: vi.fn(),
  getExistingPushSubscription: vi.fn(),
  subscribeBrowserPush: vi.fn()
}));

vi.mock("../../../lib/api/push", () => ({
  getPushPublicKey: pushApiMocks.getPushPublicKey,
  subscribePush: pushApiMocks.subscribePush,
  unsubscribePush: pushApiMocks.unsubscribePush,
  sendTestPush: pushApiMocks.sendTestPush
}));

vi.mock("../../../lib/pwa/push", () => ({
  isPushSupported: pushBrowserMocks.isPushSupported,
  getNotificationPermissionStatus: pushBrowserMocks.getNotificationPermissionStatus,
  requestNotificationPermission: pushBrowserMocks.requestNotificationPermission,
  getExistingPushSubscription: pushBrowserMocks.getExistingPushSubscription,
  subscribeBrowserPush: pushBrowserMocks.subscribeBrowserPush
}));

function createMockSubscription(endpoint = "https://push.example/subscription-1") {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: {
        p256dh: "p256dh-key",
        auth: "auth-key"
      }
    }),
    unsubscribe: vi.fn(async () => true)
  } as unknown as PushSubscription;
}

const PUSH_PREFS_STORAGE_KEY = "lwa:push-prefs:v2";

const DEFAULT_ALERT_TYPES = {
  warnings: true,
  watches: true,
  advisories: false,
  statements: true
} as const;

function makePlace(input: Partial<SavedPlace> & Pick<SavedPlace, "id" | "stateCode">): SavedPlace {
  return {
    id: input.id,
    label: input.label ?? input.id,
    rawInput: input.rawInput ?? input.stateCode,
    stateCode: input.stateCode,
    countyName: input.countyName,
    countyCode: input.countyCode,
    lat: input.lat,
    lon: input.lon,
    isPrimary: input.isPrimary ?? false,
    createdAt: input.createdAt ?? "2026-03-26T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-03-26T00:00:00.000Z"
  };
}

function seedStoredPushScopes(scopes: PushScope[]): void {
  window.localStorage.setItem(
    PUSH_PREFS_STORAGE_KEY,
    JSON.stringify({
      scopes,
      quietHours: {
        enabled: false,
        start: "22:00",
        end: "06:00"
      },
      deliveryMode: "immediate",
      pausedUntil: null
    })
  );
}

describe("usePushNotifications", () => {
  const homePlace = makePlace({
    id: "place-home",
    label: "Home",
    rawInput: "Louisville, KY",
    stateCode: "KY",
    countyName: "Jefferson County",
    countyCode: "111",
    isPrimary: true
  });

  const workPlace = makePlace({
    id: "place-work",
    label: "Work",
    rawInput: "Cincinnati, OH",
    stateCode: "OH",
    countyName: "Hamilton County",
    countyCode: "061"
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();

    pushBrowserMocks.isPushSupported.mockReturnValue(true);
    pushBrowserMocks.getNotificationPermissionStatus.mockReturnValue("default");
    pushBrowserMocks.requestNotificationPermission.mockResolvedValue("granted");
    pushBrowserMocks.getExistingPushSubscription.mockResolvedValue(null);
    pushBrowserMocks.subscribeBrowserPush.mockResolvedValue(createMockSubscription());

    pushApiMocks.getPushPublicKey.mockResolvedValue({
      publicKey: "vapid-public-key"
    });
    pushApiMocks.subscribePush.mockResolvedValue({
      ok: true,
      subscriptionId: "sub-1",
      stateCode: "KY",
      indexedStateCodes: ["KY"]
    });
    pushApiMocks.unsubscribePush.mockResolvedValue({
      ok: true,
      removed: true
    });
    pushApiMocks.sendTestPush.mockResolvedValue({
      ok: true
    });
  });

  it("marks unsupported browsers and avoids subscription flow", async () => {
    pushBrowserMocks.isPushSupported.mockReturnValue(false);
    pushBrowserMocks.getNotificationPermissionStatus.mockReturnValue("unsupported");

    const { result } = renderHook(() => usePushNotifications([], null));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.supported).toBe(false);
    expect(result.current.permission).toBe("unsupported");

    await act(async () => {
      await result.current.subscribe();
    });

    expect(pushApiMocks.subscribePush).not.toHaveBeenCalled();
    expect(result.current.error).toContain("does not support");
  });

  it("subscribes with stable place scope metadata", async () => {
    const { result } = renderHook(() =>
      usePushNotifications([homePlace], homePlace.id)
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(pushApiMocks.getPushPublicKey).toHaveBeenCalledTimes(1);
    expect(pushBrowserMocks.subscribeBrowserPush).toHaveBeenCalledWith("vapid-public-key");
    expect(pushApiMocks.subscribePush).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.subscribePush).toHaveBeenCalledWith(
      expect.objectContaining({
        stateCode: "KY",
        prefs: expect.objectContaining({
          scopes: expect.arrayContaining([
            expect.objectContaining({
              id: "place:place-home",
              placeId: "place-home",
              stateCode: "KY",
              deliveryScope: "county",
              countyFips: "111"
            })
          ])
        }),
        subscription: expect.objectContaining({
          endpoint: "https://push.example/subscription-1"
        })
      })
    );
    expect(result.current.isSubscribed).toBe(true);
  });

  it("keeps same-state custom scopes as custom scopes unless place linkage is explicit", async () => {
    seedStoredPushScopes([
      {
        id: "custom-ky-state",
        placeId: null,
        label: "Kentucky Metro Alerts",
        stateCode: "KY",
        deliveryScope: "state",
        countyName: null,
        countyFips: null,
        enabled: true,
        alertTypes: { ...DEFAULT_ALERT_TYPES },
        severeOnly: false
      }
    ]);

    const { result } = renderHook(() =>
      usePushNotifications([homePlace], homePlace.id)
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.placeScopes.map((scope) => scope.id)).toEqual([
      "place:place-home"
    ]);
    expect(result.current.customScopes.map((scope) => scope.id)).toContain(
      "custom-ky-state"
    );
  });

  it("does not absorb county custom scopes when the county does not match the place", async () => {
    seedStoredPushScopes([
      {
        id: "custom-ky-county-other",
        placeId: null,
        label: "Different KY County",
        stateCode: "KY",
        deliveryScope: "county",
        countyName: "Bullitt County",
        countyFips: "029",
        enabled: true,
        alertTypes: { ...DEFAULT_ALERT_TYPES },
        severeOnly: false
      }
    ]);

    const { result } = renderHook(() =>
      usePushNotifications([homePlace], homePlace.id)
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.placeScopes.map((scope) => scope.id)).toEqual([
      "place:place-home"
    ]);
    expect(result.current.customScopes.map((scope) => scope.id)).toContain(
      "custom-ky-county-other"
    );
  });

  it("keeps explicit place scopes reconciled by placeId and place:* ids", async () => {
    seedStoredPushScopes([
      {
        id: "legacy-home-scope",
        placeId: "place-home",
        label: "Legacy Home Scope",
        stateCode: "KY",
        deliveryScope: "county",
        countyName: "Jefferson County",
        countyFips: "111",
        enabled: false,
        alertTypes: {
          warnings: false,
          watches: true,
          advisories: true,
          statements: false
        },
        severeOnly: true
      },
      {
        id: "place:place-work",
        placeId: null,
        label: "Legacy Work Scope",
        stateCode: "OH",
        deliveryScope: "county",
        countyName: "Hamilton County",
        countyFips: "061",
        enabled: true,
        alertTypes: {
          warnings: true,
          watches: false,
          advisories: false,
          statements: true
        },
        severeOnly: false
      },
      {
        id: "custom-in",
        placeId: null,
        label: "Indiana Alerts",
        stateCode: "IN",
        deliveryScope: "state",
        countyName: null,
        countyFips: null,
        enabled: true,
        alertTypes: { ...DEFAULT_ALERT_TYPES },
        severeOnly: false
      }
    ]);

    const { result, rerender } = renderHook(
      ({ places, activePlaceId }: { places: SavedPlace[]; activePlaceId: string | null }) =>
        usePushNotifications(places, activePlaceId),
      {
        initialProps: {
          places: [homePlace, workPlace],
          activePlaceId: homePlace.id
        }
      }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.placeScopes.map((scope) => scope.id)).toEqual([
      "place:place-home",
      "place:place-work"
    ]);
    expect(result.current.customScopes.map((scope) => scope.id)).toContain("custom-in");

    const homeScope = result.current.placeScopes.find(
      (scope) => scope.placeId === "place-home"
    );
    expect(homeScope).toBeDefined();
    expect(homeScope?.enabled).toBe(false);
    expect(homeScope?.severeOnly).toBe(true);
    expect(homeScope?.alertTypes).toEqual({
      warnings: false,
      watches: true,
      advisories: true,
      statements: false
    });

    rerender({
      places: [workPlace],
      activePlaceId: workPlace.id
    });

    await waitFor(() => {
      expect(result.current.placeScopes.map((scope) => scope.id)).toEqual([
        "place:place-work"
      ]);
    });
    expect(result.current.customScopes.map((scope) => scope.id)).toContain("custom-in");
  });

  it("reconciles place scopes when places change and removes stale place scopes", async () => {
    const { result, rerender } = renderHook(
      ({ places, activePlaceId }: { places: SavedPlace[]; activePlaceId: string | null }) =>
        usePushNotifications(places, activePlaceId),
      {
        initialProps: {
          places: [homePlace],
          activePlaceId: homePlace.id
        }
      }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.placeScopes.map((scope) => scope.placeId)).toEqual([
      "place-home"
    ]);

    rerender({
      places: [workPlace],
      activePlaceId: workPlace.id
    });

    await waitFor(() => {
      expect(result.current.placeScopes.map((scope) => scope.placeId)).toEqual([
        "place-work"
      ]);
    });
    expect(result.current.placeScopes[0]?.id).toBe("place:place-work");
  });

  it("supports test notification and unsubscribe flow", async () => {
    const existingSubscription = createMockSubscription(
      "https://push.example/subscription-2"
    );
    pushBrowserMocks.getExistingPushSubscription.mockResolvedValue(existingSubscription);

    const { result } = renderHook(() =>
      usePushNotifications([homePlace], homePlace.id)
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isSubscribed).toBe(true);

    await act(async () => {
      await result.current.sendTestNotification();
    });

    expect(pushApiMocks.sendTestPush).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: expect.objectContaining({
          endpoint: "https://push.example/subscription-2"
        })
      })
    );

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(pushApiMocks.unsubscribePush).toHaveBeenCalledWith(
      "https://push.example/subscription-2"
    );
    expect((existingSubscription.unsubscribe as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    expect(result.current.isSubscribed).toBe(false);
  });
});
