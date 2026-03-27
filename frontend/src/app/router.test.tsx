import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router";
import {
  LOCATION_MODAL_DISMISSED_KEY,
  LOCATION_STORAGE_KEY
} from "../lib/storage/location";
import { PLACES_STORAGE_KEY } from "../lib/storage/places";

const ALERTS_LAST_SEEN_AT_KEY = "lwa:alerts:last-seen-at:v1";
const ALERTS_LAST_SEEN_BY_PLACE_KEY = "lwa:alerts:last-seen-by-place:v1";

const {
  getAlertsMock,
  getAlertByIdMock,
  getAlertChangesMock,
  getAlertHistoryMock,
  getWeatherMock
} =
  vi.hoisted(() => ({
  getAlertsMock: vi.fn(async () => ({
    alerts: [
      {
        id: "alert-1",
        stateCode: "OH",
        ugc: ["OHC001"],
        category: "warning",
        detailUrl: "/alerts/alert-1",
        summary: "Take shelter now",
        instructionsSummary: "Move to an interior room.",
        event: "Tornado Warning",
        areaDesc: "Franklin County",
        severity: "Severe",
        status: "Actual",
        urgency: "Immediate",
        certainty: "Observed",
        headline: "Take shelter now",
        description: "WHAT...Tornado warning in effect.",
        instruction: "Move to an interior room.",
        sent: "2026-03-26T12:00:00.000Z",
        effective: "2026-03-26T12:00:00.000Z",
        onset: "2026-03-26T12:00:00.000Z",
        expires: "2026-03-26T13:00:00.000Z",
        updated: "2026-03-26T12:05:00.000Z",
        nwsUrl: "https://example.com/alert-1"
      }
    ],
    lastPoll: "2026-03-26T12:05:00.000Z",
    syncError: null,
    meta: {
      lastPoll: "2026-03-26T12:05:00.000Z",
      generatedAt: "2026-03-26T12:05:00.000Z",
      syncError: null,
      stale: false,
      staleMinutes: 0,
      count: 1
    }
  })),
  getAlertByIdMock: vi.fn(async (alertId: string) => {
    if (alertId === "alert-1") {
      return {
        alert: {
          id: "alert-1",
          stateCode: "OH",
          ugc: ["OHC001"],
          category: "warning",
          detailUrl: "/alerts/alert-1",
          summary: "Take shelter now",
          instructionsSummary: "Move to an interior room.",
          event: "Tornado Warning",
          areaDesc: "Franklin County",
          severity: "Severe",
          status: "Actual",
          urgency: "Immediate",
          certainty: "Observed",
          headline: "Take shelter now",
          description: "WHAT...Tornado warning in effect.",
          instruction: "Move to an interior room.",
          sent: "2026-03-26T12:00:00.000Z",
          effective: "2026-03-26T12:00:00.000Z",
          onset: "2026-03-26T12:00:00.000Z",
          expires: "2026-03-26T13:00:00.000Z",
          updated: "2026-03-26T12:05:00.000Z",
          nwsUrl: "https://example.com/alert-1"
        },
        meta: {
          lastPoll: "2026-03-26T12:05:00.000Z",
          generatedAt: "2026-03-26T12:05:00.000Z",
          syncError: null,
          stale: false,
          staleMinutes: 0,
          count: 1
        }
      };
    }
    throw new Error("Alert not found.");
  }),
  getAlertChangesMock: vi.fn(async () => ({
    changes: [] as any[],
    generatedAt: "2026-03-26T12:05:00.000Z"
  })),
  getAlertHistoryMock: vi.fn(async () => ({
    days: [] as any[],
    generatedAt: "2026-03-26T12:05:00.000Z",
    meta: {
      state: "OH",
      countyCode: "153",
      daysRequested: 1
    }
  })),
  getWeatherMock: vi.fn(async () => ({
    location: {
      label: "Test Location",
      state: "OH"
    },
    current: {
      temperatureF: 70,
      feelsLikeF: 70,
      condition: "Clear",
      windMph: 5,
      windDirection: "N",
      isNight: false
    },
    hourly: [],
    daily: []
  }))
}));

vi.mock("../lib/api/alerts", () => ({
  getAlerts: getAlertsMock,
  getAlertById: getAlertByIdMock,
  getAlertChanges: getAlertChangesMock,
  getAlertHistory: getAlertHistoryMock
}));

vi.mock("../lib/api/weather", () => ({
  getWeather: getWeatherMock
}));

vi.mock("../lib/api/geocode", () => ({
  geocodeByZip: vi.fn(),
  geocodeByQuery: vi.fn()
}));

describe("appRouter", () => {
  const seedLocationModalDismissed = () => {
    window.localStorage.setItem(LOCATION_MODAL_DISMISSED_KEY, "1");
  };

  const seedSavedCountyPreference = () => {
    window.localStorage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({
        stateCode: "OH",
        rawInput: "Akron, OH",
        label: "Akron, OH",
        countyName: "Summit County",
        countyCode: "153",
        lat: 41.0814,
        lon: -81.519,
        savedAt: "2026-03-26T00:00:00.000Z"
      })
    );
  };

  const seedSavedPlaces = () => {
    window.localStorage.setItem(
      PLACES_STORAGE_KEY,
      JSON.stringify([
        {
          id: "place-home",
          label: "Home",
          rawInput: "Louisville, KY",
          stateCode: "KY",
          countyName: "Jefferson County",
          countyCode: "111",
          lat: 38.2527,
          lon: -85.7585,
          isPrimary: true,
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z"
        },
        {
          id: "place-work",
          label: "Work",
          rawInput: "Cincinnati, OH",
          stateCode: "OH",
          countyName: "Hamilton County",
          countyCode: "061",
          lat: 39.1031,
          lon: -84.512,
          isPrimary: false,
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z"
        }
      ])
    );
  };

  beforeEach(() => {
    window.localStorage.clear();
    seedLocationModalDismissed();

    getAlertsMock.mockReset();
    getAlertByIdMock.mockReset();
    getAlertChangesMock.mockReset();
    getAlertHistoryMock.mockReset();
    getWeatherMock.mockReset();

    getAlertsMock.mockImplementation(async () => ({
      alerts: [
        {
          id: "alert-1",
          stateCode: "OH",
          ugc: ["OHC001"],
          category: "warning",
          detailUrl: "/alerts/alert-1",
          summary: "Take shelter now",
          instructionsSummary: "Move to an interior room.",
          event: "Tornado Warning",
          areaDesc: "Franklin County",
          severity: "Severe",
          status: "Actual",
          urgency: "Immediate",
          certainty: "Observed",
          headline: "Take shelter now",
          description: "WHAT...Tornado warning in effect.",
          instruction: "Move to an interior room.",
          sent: "2026-03-26T12:00:00.000Z",
          effective: "2026-03-26T12:00:00.000Z",
          onset: "2026-03-26T12:00:00.000Z",
          expires: "2026-03-26T13:00:00.000Z",
          updated: "2026-03-26T12:05:00.000Z",
          nwsUrl: "https://example.com/alert-1"
        }
      ],
      lastPoll: "2026-03-26T12:05:00.000Z",
      syncError: null,
      meta: {
        lastPoll: "2026-03-26T12:05:00.000Z",
        generatedAt: "2026-03-26T12:05:00.000Z",
        syncError: null,
        stale: false,
        staleMinutes: 0,
        count: 1
      }
    }));

    getAlertByIdMock.mockImplementation(async (alertId: string) => {
      if (alertId === "alert-1") {
        return {
          alert: {
            id: "alert-1",
            stateCode: "OH",
            ugc: ["OHC001"],
            category: "warning",
            detailUrl: "/alerts/alert-1",
            summary: "Take shelter now",
            instructionsSummary: "Move to an interior room.",
            event: "Tornado Warning",
            areaDesc: "Franklin County",
            severity: "Severe",
            status: "Actual",
            urgency: "Immediate",
            certainty: "Observed",
            headline: "Take shelter now",
            description: "WHAT...Tornado warning in effect.",
            instruction: "Move to an interior room.",
            sent: "2026-03-26T12:00:00.000Z",
            effective: "2026-03-26T12:00:00.000Z",
            onset: "2026-03-26T12:00:00.000Z",
            expires: "2026-03-26T13:00:00.000Z",
            updated: "2026-03-26T12:05:00.000Z",
            nwsUrl: "https://example.com/alert-1"
          },
          meta: {
            lastPoll: "2026-03-26T12:05:00.000Z",
            generatedAt: "2026-03-26T12:05:00.000Z",
            syncError: null,
            stale: false,
            staleMinutes: 0,
            count: 1
          }
        };
      }
      throw new Error("Alert not found.");
    });

    getAlertChangesMock.mockResolvedValue({
      changes: [] as any[],
      generatedAt: "2026-03-26T12:05:00.000Z"
    });
    getAlertHistoryMock.mockResolvedValue({
      days: [] as any[],
      generatedAt: "2026-03-26T12:05:00.000Z",
      meta: {
        state: "OH",
        countyCode: "153",
        daysRequested: 1
      }
    });

    getWeatherMock.mockResolvedValue({
      location: {
        label: "Test Location",
        state: "OH"
      },
      current: {
        temperatureF: 70,
        feelsLikeF: 70,
        condition: "Clear",
        windMph: 5,
        windDirection: "N",
        isNight: false
      },
      hourly: [],
      daily: []
    });
  });

  it("renders via RouterProvider and marks forecast as active on /forecast", async () => {
    window.history.pushState({}, "", "/forecast");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Weather Alerts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forecast" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("renders the dedicated alert detail page even when saved county filter excludes the list", async () => {
    seedSavedCountyPreference();
    window.history.pushState({}, "", "/alerts/alert-1");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(getAlertByIdMock).toHaveBeenCalledWith("alert-1", expect.any(AbortSignal));
    });
    expect(getAlertsMock).not.toHaveBeenCalled();

    expect(
      await screen.findByRole("heading", { name: "Take shelter now" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByText("No matching alerts")).not.toBeInTheDocument();
  });

  it("opens a shared alert-card link in expanded list view even when filters would exclude it", async () => {
    seedSavedPlaces();
    window.history.pushState({}, "", "/alerts?focusAlert=alert-1#alert-alert-1");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Ohio • 1 county")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse details" })).toBeInTheDocument();
    expect(screen.queryByText("No matching alerts")).not.toBeInTheDocument();
    expect(getAlertByIdMock).not.toHaveBeenCalled();
  });

  it("uses detail endpoint metadata for freshness messaging", async () => {
    getAlertByIdMock.mockResolvedValueOnce({
      alert: {
        id: "alert-1",
        stateCode: "OH",
        ugc: ["OHC001"],
        category: "warning",
        detailUrl: "/alerts/alert-1",
        summary: "Take shelter now",
        instructionsSummary: "Move to an interior room.",
        event: "Tornado Warning",
        areaDesc: "Franklin County",
        severity: "Severe",
        status: "Actual",
        urgency: "Immediate",
        certainty: "Observed",
        headline: "Take shelter now",
        description: "WHAT...Tornado warning in effect.",
        instruction: "Move to an interior room.",
        sent: "2026-03-26T12:00:00.000Z",
        effective: "2026-03-26T12:00:00.000Z",
        onset: "2026-03-26T12:00:00.000Z",
        expires: "2026-03-26T13:00:00.000Z",
        updated: "2026-03-26T12:05:00.000Z",
        nwsUrl: "https://example.com/alert-1"
      },
      meta: {
        lastPoll: "2026-03-26T10:00:00.000Z",
        generatedAt: "2026-03-26T12:05:00.000Z",
        syncError: null,
        stale: true,
        staleMinutes: 125,
        count: 1
      }
    });

    window.history.pushState({}, "", "/alerts/alert-1");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByText(/Alert data may be stale \(125 minutes old\)\. Last/i)
    ).toBeInTheDocument();
    expect(getAlertsMock).not.toHaveBeenCalled();
  });

  it("keeps detail route usable when the alerts list request fails or is skipped", async () => {
    getAlertsMock.mockRejectedValueOnce(new Error("Unable to load weather alerts."));
    window.history.pushState({}, "", "/alerts/alert-1");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(getAlertByIdMock).toHaveBeenCalledWith("alert-1", expect.any(AbortSignal));
    });

    expect(
      await screen.findByRole("heading", { name: "Take shelter now" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Could not load alerts:")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(getAlertsMock).not.toHaveBeenCalled();
  });

  it("keeps expired detail closure-first and suppresses live-threat impact cards", async () => {
    getAlertByIdMock.mockResolvedValueOnce({
      alert: {
        id: "alert-1",
        stateCode: "OH",
        ugc: ["OHC001"],
        category: "warning",
        detailUrl: "/alerts/alert-1",
        summary: "Tornado warning has ended.",
        instructionsSummary: "Continue checking for debris before travel.",
        event: "Tornado Warning",
        areaDesc: "Franklin County",
        severity: "Severe",
        status: "Actual",
        urgency: "Immediate",
        certainty: "Observed",
        headline: "Tornado warning has ended",
        description: "Storm threat has moved out of the area.",
        instruction: "Check roads for debris before heading out.",
        sent: "2026-03-26T12:00:00.000Z",
        effective: "2026-03-26T12:00:00.000Z",
        onset: "2026-03-26T12:00:00.000Z",
        expires: "2000-01-01T00:00:00.000Z",
        updated: "2026-03-26T12:05:00.000Z",
        nwsUrl: "https://example.com/alert-1",
        impactCategories: ["tornado", "wind"],
        isMajor: true
      },
      meta: {
        lastPoll: "2026-03-26T12:05:00.000Z",
        generatedAt: "2026-03-26T12:05:00.000Z",
        syncError: null,
        stale: false,
        staleMinutes: 0,
        count: 1
      }
    } as any);

    window.history.pushState({}, "", "/alerts/alert-1");
    const router = createAppRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("This alert has expired.")).toBeInTheDocument();
    expect(await screen.findByText("Alert window ended")).toBeInTheDocument();
    expect(screen.queryByText("Shelter decision window")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Move everyone to a lowest interior room away from windows now/i)
    ).not.toBeInTheDocument();
  });

  it("shows a clear error state for invalid /alerts/:alertId routes", async () => {
    getAlertChangesMock.mockResolvedValueOnce({
      changes: [
        {
          alertId: "does-not-exist",
          stateCodes: ["OH"],
          countyCodes: ["153"],
          event: "Tornado Warning",
          areaDesc: "Summit County",
          changedAt: "2026-03-26T12:20:00.000Z",
          changeType: "expired",
          previousExpires: "2026-03-26T12:00:00.000Z",
          nextExpires: null
        }
      ],
      generatedAt: "2026-03-26T12:30:00.000Z"
    });

    window.history.pushState({}, "", "/alerts/does-not-exist");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(getAlertByIdMock).toHaveBeenCalledWith(
        "does-not-exist",
        expect.any(AbortSignal)
      );
    });

    expect(await screen.findByText("Alert not found.")).toBeInTheDocument();
    expect(await screen.findByText(/has expired/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to alerts" })).toBeInTheDocument();
  });

  it("switches forecast context when primary place changes", async () => {
    seedSavedPlaces();
    window.history.pushState({}, "", "/forecast");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(getWeatherMock).toHaveBeenCalledWith({
        lat: 38.2527,
        lon: -85.7585
      });
    });

    fireEvent.change(screen.getByLabelText("Primary place"), {
      target: { value: "place-work" }
    });

    await waitFor(() => {
      expect(getWeatherMock).toHaveBeenCalledWith({
        lat: 39.1031,
        lon: -84.512
      });
    });
  });

  it("updates change-summary banner context when primary place switches on /alerts", async () => {
    seedSavedPlaces();
    window.localStorage.setItem(
      ALERTS_LAST_SEEN_AT_KEY,
      "2026-03-26T10:00:00.000Z"
    );
    window.localStorage.setItem(
      ALERTS_LAST_SEEN_BY_PLACE_KEY,
      JSON.stringify({
        "place-home": "2026-03-26T08:00:00.000Z",
        "place-work": "2026-03-26T09:30:00.000Z"
      })
    );
    window.history.pushState({}, "", "/alerts");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(getAlertChangesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          since: "2026-03-26T08:00:00.000Z",
          state: "KY",
          countyCode: "111"
        })
      );
    });
    expect(
      await screen.findByText(/What changed for Home since your last visit/i)
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Primary place"), {
      target: { value: "place-work" }
    });

    await waitFor(() => {
      expect(getAlertChangesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          since: "2026-03-26T09:30:00.000Z",
          state: "OH",
          countyCode: "061"
        })
      );
    });
    expect(
      await screen.findByText(/What changed for Work since your last visit/i)
    ).toBeInTheDocument();

    const homeTimestampWithWorkFilters = (
      getAlertChangesMock.mock.calls as unknown[][]
    ).some((call) => {
        const payload = (call[0] ?? {}) as {
          since?: string;
          state?: string;
          countyCode?: string;
        };
        return (
          payload.since === "2026-03-26T08:00:00.000Z" &&
          payload.state === "OH" &&
          payload.countyCode === "061"
        );
      });
    expect(homeTimestampWithWorkFilters).toBe(false);
  });

  it("renders stronger since-last-visit summary cards with closure highlights", async () => {
    seedSavedPlaces();
    window.localStorage.setItem(
      ALERTS_LAST_SEEN_BY_PLACE_KEY,
      JSON.stringify({
        "place-home": "2026-03-26T08:00:00.000Z"
      })
    );

    getAlertChangesMock.mockResolvedValueOnce({
      changes: [
        {
          alertId: "new-1",
          stateCodes: ["KY"],
          countyCodes: ["111"],
          event: "Tornado Warning",
          areaDesc: "Jefferson County",
          changedAt: "2026-03-26T12:00:00.000Z",
          changeType: "new",
          previousExpires: null,
          nextExpires: "2026-03-26T13:00:00.000Z"
        },
        {
          alertId: "expired-1",
          stateCodes: ["KY"],
          countyCodes: ["111"],
          event: "Flood Warning",
          areaDesc: "Jefferson County",
          changedAt: "2026-03-26T12:10:00.000Z",
          changeType: "expired",
          previousExpires: "2026-03-26T12:00:00.000Z",
          nextExpires: null
        },
        {
          alertId: "all-clear:KY",
          stateCodes: ["KY"],
          countyCodes: [],
          event: "All Clear",
          areaDesc: "Kentucky",
          changedAt: "2026-03-26T12:20:00.000Z",
          changeType: "all_clear",
          previousExpires: null,
          nextExpires: null
        }
      ],
      generatedAt: "2026-03-26T12:30:00.000Z"
    });

    window.history.pushState({}, "", "/alerts");
    const router = createAppRouter();

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("New Alerts")).toBeInTheDocument();
    expect(await screen.findByText("Expired Alerts")).toBeInTheDocument();
    expect(await screen.findByText("All Clear Updates")).toBeInTheDocument();
    expect(await screen.findByText("Recent closure updates")).toBeInTheDocument();
  });

  it("exposes skip navigation and completes alerts reconnect state", async () => {
    window.history.pushState({}, "", "/alerts");
    const router = createAppRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Weather Alerts" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Skip to main content" })
    ).toBeInTheDocument();

    const baselineCalls = getAlertsMock.mock.calls.length;
    fireEvent(window, new Event("offline"));
    fireEvent(window, new Event("online"));

    await waitFor(() => {
      expect(getAlertsMock.mock.calls.length).toBeGreaterThan(baselineCalls);
    });
    expect(
      await screen.findByText(/Live updates restored at/i)
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(
          screen.queryByText(
            /Connection restored\. Refreshing alerts, forecast, and route details now/i
          )
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Live updates restored at/i)).not.toBeInTheDocument();
      },
      { timeout: 7000 }
    );
  }, 12000);

  it("keeps forecast reconnect behavior working through completion", async () => {
    window.history.pushState({}, "", "/forecast");
    const forecastRouter = createAppRouter();
    render(<RouterProvider router={forecastRouter} />);
    await waitFor(() => {
      expect(getWeatherMock).toHaveBeenCalled();
    });
    const weatherCalls = getWeatherMock.mock.calls.length;

    fireEvent(window, new Event("online"));
    await waitFor(() => {
      expect(getWeatherMock.mock.calls.length).toBeGreaterThan(weatherCalls);
    });
    expect(
      await screen.findByText(/Live updates restored at/i)
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(
          screen.queryByText(
            /Connection restored\. Refreshing alerts, forecast, and route details now/i
          )
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Live updates restored at/i)).not.toBeInTheDocument();
      },
      { timeout: 7000 }
    );
  }, 12000);

  it("refreshes detail routes and clears reconnecting state after completion", async () => {
    seedSavedCountyPreference();
    window.history.pushState({}, "", "/alerts/alert-1");
    const detailRouter = createAppRouter();
    render(<RouterProvider router={detailRouter} />);

    await waitFor(() => {
      expect(getAlertByIdMock).toHaveBeenCalledWith("alert-1", expect.any(AbortSignal));
    });
    const detailCalls = getAlertByIdMock.mock.calls.length;
    fireEvent(window, new Event("online"));
    await waitFor(() => {
      expect(getAlertByIdMock.mock.calls.length).toBeGreaterThan(detailCalls);
    });
    expect(
      await screen.findByText(/Live updates restored at/i)
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(
          screen.queryByText(
            /Connection restored\. Refreshing alerts, forecast, and route details now/i
          )
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Live updates restored at/i)).not.toBeInTheDocument();
      },
      { timeout: 7000 }
    );
  }, 12000);

  it("shows update affordance after a service worker refresh event", async () => {
    window.history.pushState({}, "", "/settings");
    const router = createAppRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "More" })).toBeInTheDocument();
    fireEvent(
      window,
      new CustomEvent("lwa:pwa-update-available")
    );

    expect(
      await screen.findByRole("button", { name: "Apply Update" })
    ).toBeInTheDocument();
  });

  it("refreshes history routes and clears reconnecting state after completion", async () => {
    seedSavedCountyPreference();
    window.history.pushState({}, "", "/history");
    const historyRouter = createAppRouter();
    render(<RouterProvider router={historyRouter} />);
    await waitFor(() => {
      expect(getAlertHistoryMock).toHaveBeenCalled();
    });
    const historyCalls = getAlertHistoryMock.mock.calls.length;
    fireEvent(window, new Event("online"));
    await waitFor(() => {
      expect(getAlertHistoryMock.mock.calls.length).toBeGreaterThan(historyCalls);
    });
    expect(
      await screen.findByText(/Live updates restored at/i)
    ).toBeInTheDocument();
    await waitFor(
      () => {
        expect(
          screen.queryByText(
            /Connection restored\. Refreshing alerts, forecast, and route details now/i
          )
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/Live updates restored at/i)).not.toBeInTheDocument();
      },
      { timeout: 7000 }
    );
  }, 12000);
});
