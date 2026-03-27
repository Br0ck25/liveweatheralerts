import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AlertLifecycleBadge } from "./AlertLifecycleBadge";

describe("AlertLifecycleBadge", () => {
  it("renders expected labels for lifecycle statuses", () => {
    render(
      <div>
        <AlertLifecycleBadge status="new" />
        <AlertLifecycleBadge status="updated" />
        <AlertLifecycleBadge status="extended" />
        <AlertLifecycleBadge status="expiring_soon" />
        <AlertLifecycleBadge status="expired" />
        <AlertLifecycleBadge status="all_clear" />
      </div>
    );

    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("Extended")).toBeInTheDocument();
    expect(screen.getByText("Expiring Soon")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("All Clear")).toBeInTheDocument();
  });
});

