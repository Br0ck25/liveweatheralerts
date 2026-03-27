import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("shows inline actions after expanding and removes the standalone detail link", () => {
    render(
      <MemoryRouter>
        <AlertCard alert={sampleAlert} index={0} />
      </MemoryRouter>
    );

    expect(
      screen.queryByRole("link", { name: "Open full alert details" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand details" }));

    expect(
      screen.getByRole("button", { name: "Share" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy safety steps" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View radar" })
    ).toBeInTheDocument();
  });

  it("copies a list-card link that reopens the expanded alert card", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: writeTextMock
      }
    });

    render(
      <MemoryRouter>
        <AlertCard alert={sampleAlert} index={0} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand details" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    const expectedUrl = new URL(
      "/alerts?focusAlert=alert-1#alert-alert-1",
      window.location.origin
    ).toString();

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(expectedUrl);
    });
    expect(screen.getByText("Alert link copied.")).toBeInTheDocument();
  });
});
