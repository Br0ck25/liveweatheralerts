import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RadarPayload } from "../../../types";
import { AlertRadarPanel } from "./AlertRadarPanel";

const getRadarMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/radar", () => ({
  getRadar: getRadarMock
}));

const baseAlert = {
  id: "alert-1",
  stateCode: "KY",
  ugc: ["KYC001"],
  event: "Tornado Warning",
  areaDesc: "Test County",
  severity: "Severe",
  status: "Actual",
  urgency: "Immediate",
  certainty: "Observed",
  headline: "Take shelter now",
  description: "Tornado expected.",
  instruction: "Move to an interior room.",
  sent: "2026-03-26T12:00:00.000Z",
  effective: "2026-03-26T12:00:00.000Z",
  onset: "2026-03-26T12:00:00.000Z",
  expires: "2026-03-26T13:00:00.000Z",
  updated: "2026-03-26T12:05:00.000Z",
  nwsUrl: "https://example.com/alert-1",
  detailUrl: "/alerts/alert-1",
  lat: 37.0,
  lon: -85.0
};

describe("AlertRadarPanel", () => {
  beforeEach(() => {
    getRadarMock.mockReset();
  });

  it("prefers saved place coordinates when they match alert state", async () => {
    const payload: RadarPayload = {
      station: "KLVX",
      loopImageUrl: "https://example.com/loop.gif",
      stillImageUrl: "https://example.com/still.png",
      updated: "2026-03-26T12:10:00.000Z",
      stormDirection: "NE"
    };
    getRadarMock.mockResolvedValue(payload);

    render(
      <AlertRadarPanel
        alert={baseAlert}
        savedPlace={{
          id: "place-home",
          stateCode: "KY",
          rawInput: "40202",
          label: "Louisville, KY",
          lat: 38.25,
          lon: -85.76,
          isPrimary: true,
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z"
        }}
        isOffline={false}
      />
    );

    await waitFor(() => {
      expect(getRadarMock).toHaveBeenCalledWith(
        { lat: 38.25, lon: -85.76 },
        expect.any(AbortSignal)
      );
    });

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/loop.gif"
    );
    expect(screen.getByText(/Station KLVX/i)).toBeInTheDocument();
  });

  it("shows a graceful warning when radar lookup fails", async () => {
    getRadarMock.mockRejectedValue(new Error("Radar is unavailable right now."));

    render(
      <AlertRadarPanel
        alert={baseAlert}
        savedPlace={null}
        isOffline={false}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Radar is currently unavailable/i)
      ).toBeInTheDocument();
    });
  });
});
