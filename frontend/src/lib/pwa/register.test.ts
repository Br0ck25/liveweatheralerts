import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PWA_OFFLINE_READY_EVENT,
  PWA_UPDATE_AVAILABLE_EVENT,
  applyPwaUpdate,
  registerPwaServiceWorker
} from "./register";

const updateSwMock = vi.fn(async () => undefined);
const registerSwMock = vi.fn((_: unknown) => updateSwMock);

vi.mock("virtual:pwa-register", () => ({
  registerSW: (options: unknown) => registerSwMock(options)
}));

describe("registerPwaServiceWorker", () => {
  beforeEach(() => {
    updateSwMock.mockClear();
    registerSwMock.mockClear();
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {}
    });
  });

  it("registers the service worker and dispatches install/update events", () => {
    const updateSpy = vi.fn();
    const offlineSpy = vi.fn();
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, updateSpy);
    window.addEventListener(PWA_OFFLINE_READY_EVENT, offlineSpy);

    registerPwaServiceWorker();

    expect(registerSwMock).toHaveBeenCalledTimes(1);
    const options = (registerSwMock.mock.calls[0]?.[0] ?? {}) as {
      onNeedRefresh?: () => void;
      onOfflineReady?: () => void;
    };
    expect(typeof options.onNeedRefresh).toBe("function");
    expect(typeof options.onOfflineReady).toBe("function");

    options.onNeedRefresh?.();
    options.onOfflineReady?.();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(offlineSpy).toHaveBeenCalledTimes(1);
  });

  it("applies a pending service worker update", async () => {
    registerPwaServiceWorker();
    const applied = await applyPwaUpdate();
    expect(applied).toBe(true);
    expect(updateSwMock).toHaveBeenCalledWith(true);
  });
});
