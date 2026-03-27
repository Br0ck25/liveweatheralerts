import type { ReactNode } from "react";

type AlertDetailSectionProps = {
  title: string;
  children: ReactNode;
};

export function AlertDetailSection({ title, children }: AlertDetailSectionProps) {
  return (
    <section className="alert-detail-section">
      <h2>{title}</h2>
      <div className="alert-detail-section-body">{children}</div>
    </section>
  );
}
