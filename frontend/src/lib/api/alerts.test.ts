import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAlertHistory } from "./alerts";

describe("getAlertHistory", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes /api/alerts/history response into typed day models", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          days: [
            {
              day: "2026-03-26",
              generatedAt: "2026-03-26T13:00:00.000Z",
              summary: {
                totalEntries: 2,
                activeAlertCount: 1,
                activeWarningCount: 1,
                activeMajorCount: 1,
                topEvents: [{ event: "Tornado Warning", count: 2 }],
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
                  stateCodes: ["ky"],
                  countyCodes: ["111"],
                  event: "Tornado Warning",
                  areaDesc: "Jefferson County",
                  changedAt: "2026-03-26T12:05:00.000Z",
                  changeType: "new",
                  severity: "Extreme",
                  category: "warning",
                  isMajor: true,
                  summary: "Issued"
                },
                {
                  alertId: "alert-2",
                  stateCodes: ["KY"],
                  countyCodes: ["111"],
                  event: "Flood Advisory",
                  areaDesc: "Jefferson County",
                  changedAt: "2026-03-26T12:10:00.000Z",
                  changeType: "updated",
                  severity: "Minor",
                  category: "advisory",
                  isMajor: false,
                  summary: "Updated"
                }
              ]
            }
          ],
          generatedAt: "2026-03-26T13:00:00.000Z",
          meta: {
            state: "KY",
            countyCode: "111",
            daysRequested: 7
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const payload = await getAlertHistory({
      state: "ky",
      countyCode: "111",
      days: 7
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/alerts/history?"),
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain("state=KY");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("countyCode=111");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("days=7");

    expect(payload.days).toHaveLength(1);
    expect(payload.days[0]?.day).toBe("2026-03-26");
    expect(payload.days[0]?.summary.totalEntries).toBe(2);
    expect(payload.days[0]?.entries[0]?.stateCodes).toEqual(["KY"]);
    expect(payload.days[0]?.entries[1]?.category).toBe("advisory");
    expect(payload.days[0]?.summary.topEvents[0]?.event).toBe("Tornado Warning");
    expect(payload.meta.daysRequested).toBe(7);
  });
});
