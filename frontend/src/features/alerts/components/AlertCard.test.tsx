import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AlertCard } from "./AlertCard";

const sampleAlert = {
  id: "alert-1",
  stateCode: "OH",
  ugc: ["OHC001"],
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
  nwsUrl: "https://example.com/alert-1",
  detailUrl: "/alerts/alert-1"
};

describe("AlertCard highlight sync", () => {
  it("auto-expands when isHighlighted changes after mount", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <AlertCard alert={sampleAlert} index={0} isHighlighted={false} />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("button", { name: "Expand details" })
    ).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <AlertCard alert={sampleAlert} index={0} isHighlighted />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Collapse details" })
      ).toBeInTheDocument();
    });
  });

  it("links to the canonical alert detail route", () => {
    render(
      <MemoryRouter>
        <AlertCard alert={sampleAlert} index={0} />
      </MemoryRouter>
    );

    expect(
      screen.getByRole("link", { name: "Open full alert details" })
    ).toHaveAttribute("href", "/alerts/alert-1");
  });
});
