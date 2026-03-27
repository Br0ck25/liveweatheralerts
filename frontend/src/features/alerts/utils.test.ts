import { describe, expect, it } from "vitest";
import type { AlertChangeRecord } from "../../types";
import {
  buildAlertChangeSummaryCards,
  buildImpactCardsForAlert,
  classifyAlertType,
  selectClosureHighlights
} from "./utils";

describe("classifyAlertType", () => {
  it("maps common alert labels to expected types", () => {
    expect(classifyAlertType("Tornado Warning")).toBe("warning");
    expect(classifyAlertType("Flood Watch")).toBe("watch");
    expect(classifyAlertType("Wind Advisory")).toBe("advisory");
    expect(classifyAlertType("Special Weather Statement")).toBe("statement");
    expect(classifyAlertType("Weather Message")).toBe("other");
  });
});

describe("buildImpactCardsForAlert", () => {
  it("returns action-oriented cards for tornado scenarios", () => {
    const cards = buildImpactCardsForAlert({
      event: "Tornado Warning",
      severity: "Severe",
      areaDesc: "Franklin County",
      impactCategories: ["tornado", "wind"],
      expires: "2099-03-26T13:00:00.000Z",
      lifecycleStatus: "new",
      isMajor: true
    });

    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((card) => card.title.includes("Shelter"))).toBe(true);
    expect(cards.some((card) => card.action.toLowerCase().includes("interior"))).toBe(
      true
    );
  });

  it("returns closure-first cards for all-clear lifecycle status", () => {
    const cards = buildImpactCardsForAlert({
      event: "Flood Warning",
      severity: "Moderate",
      areaDesc: "Summit County",
      impactCategories: ["flood"],
      expires: "2099-03-26T13:00:00.000Z",
      lifecycleStatus: "all_clear",
      isMajor: true
    });

    expect(cards).toEqual([
      expect.objectContaining({
        id: "all-clear",
        tone: "clear"
      })
    ]);
  });

  it("suppresses live active-threat cards for expired tornado/flood/wind alerts", () => {
    const nowMs = Date.parse("2026-03-27T12:00:00.000Z");
    const activeThreatIds = new Set([
      "tornado-shelter",
      "flood-commute",
      "winter-road",
      "heat-health",
      "wind-power",
      "overnight-risk",
      "school-pickup",
      "outdoor-plan"
    ]);

    const scenarios = [
      { event: "Tornado Warning", impactCategories: ["tornado", "wind"] as const },
      { event: "Flood Warning", impactCategories: ["flood"] as const },
      { event: "High Wind Warning", impactCategories: ["wind"] as const }
    ];

    for (const scenario of scenarios) {
      const cards = buildImpactCardsForAlert(
        {
          event: scenario.event,
          severity: "Severe",
          areaDesc: "Test County",
          impactCategories: [...scenario.impactCategories],
          expires: "2026-03-27T10:00:00.000Z",
          lifecycleStatus: "updated",
          isMajor: true
        },
        { nowMs }
      );

      expect(cards.some((card) => card.id === "expired-window")).toBe(true);
      expect(cards.some((card) => activeThreatIds.has(card.id))).toBe(false);
    }
  });
});

describe("buildAlertChangeSummaryCards", () => {
  it("builds user-facing since-last-visit summary cards by lifecycle type", () => {
    const changes: AlertChangeRecord[] = [
      {
        alertId: "a1",
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
        alertId: "a2",
        stateCodes: ["KY"],
        countyCodes: ["111"],
        event: "Flood Warning",
        areaDesc: "Jefferson County",
        changedAt: "2026-03-26T12:10:00.000Z",
        changeType: "updated",
        previousExpires: null,
        nextExpires: null
      },
      {
        alertId: "a3",
        stateCodes: ["KY"],
        countyCodes: ["111"],
        event: "All Clear",
        areaDesc: "Kentucky",
        changedAt: "2026-03-26T12:20:00.000Z",
        changeType: "all_clear",
        previousExpires: null,
        nextExpires: null
      }
    ];

    const cards = buildAlertChangeSummaryCards(changes, "Home");
    expect(cards.map((card) => card.id)).toEqual(["new", "updated", "all_clear"]);
  });
});

describe("selectClosureHighlights", () => {
  it("prioritizes major closure changes ahead of minor expirations", () => {
    const changes: AlertChangeRecord[] = [
      {
        alertId: "minor-expired",
        stateCodes: ["KY"],
        countyCodes: [],
        event: "Wind Advisory",
        areaDesc: "Kentucky",
        changedAt: "2026-03-26T12:00:00.000Z",
        changeType: "expired",
        previousExpires: null,
        nextExpires: null
      },
      {
        alertId: "major-expired",
        stateCodes: ["KY"],
        countyCodes: [],
        event: "Tornado Warning",
        areaDesc: "Kentucky",
        changedAt: "2026-03-26T11:50:00.000Z",
        changeType: "expired",
        previousExpires: null,
        nextExpires: null
      }
    ];

    const highlights = selectClosureHighlights(changes, 2);
    expect(highlights[0].alertId).toBe("major-expired");
  });
});
