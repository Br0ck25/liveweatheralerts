import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertHistoryPage } from "./AlertHistoryPage";

const getAlertHistoryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/alerts", () => ({
  getAlertHistory: getAlertHistoryMock
}));

const activePlace = {
  id: "place-home",
  label: "Home",
  rawInput: "Louisville, KY",
  stateCode: "KY",
  countyName: "Jefferson County",
  countyCode: "111",
  isPrimary: true,
  createdAt: "2026-03-26T00:00:00.000Z",
  updatedAt: "2026-03-26T00:00:00.000Z"
};

function expectSummaryCardCount(label: string, count: number) {
  const labelElement = screen.getByText(label);
  const card = labelElement.closest(".history-day-summary-card");
  expect(card).toBeTruthy();
  expect(card).toHaveTextContent(String(count));
}

describe("AlertHistoryPage", () => {
  beforeEach(() => {
    getAlertHistoryMock.mockReset();
    getAlertHistoryMock.mockResolvedValue({
      days: [
        {
          day: "2026-03-26",
          generatedAt: "2026-03-26T12:10:00.000Z",
          summary: {
            totalEntries: 2,
            activeAlertCount: 1,
            activeWarningCount: 1,
            activeMajorCount: 1,
            byLifecycle: {
              new: 1,
              updated: 1,
              extended: 0,
              expired: 0,
              all_clear: 0
            },
            byCategory: {
              warning: 2,
              watch: 0,
              advisory: 0,
              statement: 0,
              other: 0
            },
            bySeverity: {
              extreme: 1,
              severe: 1,
              moderate: 0,
              minor: 0,
              unknown: 0
            },
            topEvents: [
              {
                event: "Tornado Warning",
                count: 2
              }
            ],
            notableWarnings: [
              {
                alertId: "alert-1",
                event: "Tornado Warning",
                areaDesc: "Jefferson County",
                severity: "Extreme",
                changedAt: "2026-03-26T12:05:00.000Z",
                changeType: "new"
              }
            ]
          },
          entries: [
            {
              alertId: "alert-1",
              stateCodes: ["KY"],
              countyCodes: ["111"],
              event: "Tornado Warning",
              areaDesc: "Jefferson County",
              changedAt: "2026-03-26T12:05:00.000Z",
              changeType: "new",
              severity: "Extreme",
              category: "warning",
              isMajor: true,
              summary: "Tornado warning issued.",
              previousExpires: null,
              nextExpires: "2026-03-26T13:00:00.000Z"
            },
            {
              alertId: "alert-2",
              stateCodes: ["KY"],
              countyCodes: ["111"],
              event: "Tornado Warning",
              areaDesc: "Jefferson County",
              changedAt: "2026-03-26T12:10:00.000Z",
              changeType: "updated",
              severity: "Severe",
              category: "warning",
              isMajor: true,
              summary: "Tornado warning updated.",
              previousExpires: "2026-03-26T12:50:00.000Z",
              nextExpires: "2026-03-26T13:30:00.000Z"
            }
          ]
        }
      ],
      generatedAt: "2026-03-26T12:10:00.000Z",
      meta: {
        state: "KY",
        countyCode: "111",
        daysRequested: 1
      }
    });
  });

  it("loads 24-hour history by default and can switch to 7-day history", async () => {
    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getAlertHistoryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "KY",
          countyCode: "111",
          days: 1,
          signal: expect.any(AbortSignal)
        })
      );
    });

    fireEvent.change(screen.getByLabelText("Window"), {
      target: { value: "7" }
    });

    await waitFor(() => {
      expect(getAlertHistoryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "KY",
          countyCode: "111",
          days: 7,
          signal: expect.any(AbortSignal)
        })
      );
    });
  });

  it("supports place-aware scope filtering between county and state", async () => {
    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getAlertHistoryMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText("Place scope"), {
      target: { value: "state" }
    });

    await waitFor(() => {
      const latestCall = getAlertHistoryMock.mock.calls.at(-1)?.[0] ?? {};
      expect(latestCall).toEqual(
        expect.objectContaining({
          state: "KY",
          days: 1,
          signal: expect.any(AbortSignal)
        })
      );
      expect(latestCall.countyCode).toBeUndefined();
    });
  });

  it("shows a clear empty state when no history exists", async () => {
    getAlertHistoryMock.mockResolvedValueOnce({
      days: [],
      generatedAt: "2026-03-26T12:10:00.000Z",
      meta: {
        state: "KY",
        countyCode: "111",
        daysRequested: 1
      }
    });

    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    expect(
      await screen.findByRole("heading", { name: "No recent alert history for this view" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/still works even when there are no active alerts/i)
    ).toBeInTheDocument();
  });

  it("renders scan-friendly day summaries with top types and notable warnings", async () => {
    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    expect(await screen.findByText("Top alert types")).toBeInTheDocument();
    expect(screen.getByText("Notable warnings")).toBeInTheDocument();
    expect(screen.getByText("Place activity")).toBeInTheDocument();
    expect(screen.getByText("Recent updates")).toBeInTheDocument();
    expect(screen.getAllByText("Tornado Warning").length).toBeGreaterThan(0);
  });

  it("renders county-scoped active summary counts from the history API", async () => {
    getAlertHistoryMock.mockResolvedValueOnce({
      days: [
        {
          day: "2026-03-26",
          generatedAt: "2026-03-26T12:10:00.000Z",
          summary: {
            totalEntries: 1,
            activeAlertCount: 4,
            activeWarningCount: 2,
            activeMajorCount: 1,
            byLifecycle: {
              new: 1,
              updated: 0,
              extended: 0,
              expired: 0,
              all_clear: 0
            },
            byCategory: {
              warning: 1,
              watch: 0,
              advisory: 0,
              statement: 0,
              other: 0
            },
            bySeverity: {
              extreme: 1,
              severe: 0,
              moderate: 0,
              minor: 0,
              unknown: 0
            },
            topEvents: [{ event: "Tornado Warning", count: 1 }],
            notableWarnings: [
              {
                alertId: "alert-1",
                event: "Tornado Warning",
                areaDesc: "Jefferson County",
                severity: "Extreme",
                changedAt: "2026-03-26T12:05:00.000Z",
                changeType: "new"
              }
            ]
          },
          entries: [
            {
              alertId: "alert-1",
              stateCodes: ["KY"],
              countyCodes: ["111"],
              event: "Tornado Warning",
              areaDesc: "Jefferson County",
              changedAt: "2026-03-26T12:05:00.000Z",
              changeType: "new",
              severity: "Extreme",
              category: "warning",
              isMajor: true,
              summary: "Tornado warning issued.",
              previousExpires: null,
              nextExpires: "2026-03-26T13:00:00.000Z"
            }
          ]
        }
      ],
      generatedAt: "2026-03-26T12:10:00.000Z",
      meta: {
        state: "KY",
        countyCode: "111",
        daysRequested: 1
      }
    });

    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    await screen.findByText("Active alerts seen");
    expectSummaryCardCount("Active alerts seen", 4);
    expectSummaryCardCount("Warnings seen", 2);
    expectSummaryCardCount("Major alerts seen", 1);
  });

  it("keeps county history days visible after filtering when active counts remain non-zero", async () => {
    getAlertHistoryMock.mockResolvedValueOnce({
      days: [
        {
          day: "2026-03-26",
          generatedAt: "2026-03-26T12:10:00.000Z",
          summary: {
            totalEntries: 1,
            activeAlertCount: 3,
            activeWarningCount: 1,
            activeMajorCount: 1,
            byLifecycle: {
              new: 1,
              updated: 0,
              extended: 0,
              expired: 0,
              all_clear: 0
            },
            byCategory: {
              warning: 1,
              watch: 0,
              advisory: 0,
              statement: 0,
              other: 0
            },
            bySeverity: {
              extreme: 1,
              severe: 0,
              moderate: 0,
              minor: 0,
              unknown: 0
            },
            topEvents: [{ event: "Tornado Warning", count: 1 }],
            notableWarnings: [
              {
                alertId: "alert-1",
                event: "Tornado Warning",
                areaDesc: "Jefferson County",
                severity: "Extreme",
                changedAt: "2026-03-26T12:05:00.000Z",
                changeType: "new"
              }
            ]
          },
          entries: [
            {
              alertId: "alert-1",
              stateCodes: ["KY"],
              countyCodes: ["111"],
              event: "Tornado Warning",
              areaDesc: "Jefferson County",
              changedAt: "2026-03-26T12:05:00.000Z",
              changeType: "new",
              severity: "Extreme",
              category: "warning",
              isMajor: true,
              summary: "Tornado warning issued.",
              previousExpires: null,
              nextExpires: "2026-03-26T13:00:00.000Z"
            }
          ]
        }
      ],
      generatedAt: "2026-03-26T12:10:00.000Z",
      meta: {
        state: "KY",
        countyCode: "111",
        daysRequested: 1
      }
    });

    render(
      <MemoryRouter>
        <AlertHistoryPage isOffline={false} activePlace={activePlace} />
      </MemoryRouter>
    );

    await screen.findByText("Active alerts seen");

    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "watch" }
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "No recent alert history for this view" })
      ).not.toBeInTheDocument();
      expect(screen.getByText("0 updates tracked")).toBeInTheDocument();
    });
    expectSummaryCardCount("Active alerts seen", 3);
  });
});
