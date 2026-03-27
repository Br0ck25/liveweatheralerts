import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImpactCard } from "./ImpactCard";

describe("ImpactCard", () => {
  it("renders concise action-oriented impact content", () => {
    render(
      <ImpactCard
        card={{
          id: "wind-power",
          title: "Power outage prep",
          detail: "Strong gusts can down limbs and trigger outages.",
          action: "Charge devices and secure loose outdoor items.",
          tone: "warning"
        }}
      />
    );

    expect(screen.getByText("Power outage prep")).toBeInTheDocument();
    expect(screen.getByText(/Strong gusts can down limbs/i)).toBeInTheDocument();
    expect(screen.getByText(/Do now:/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Charge devices and secure loose outdoor items/i)
    ).toBeInTheDocument();
  });
});

