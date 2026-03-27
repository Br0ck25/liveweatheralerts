import { formatDateTime } from "../utils";
import { AlertCountdown } from "./AlertCountdown";

type AlertTimelineProps = {
  issuedAt: string;
  effectiveAt: string;
  updatedAt: string;
  expiresAt: string;
};

export function AlertTimeline({
  issuedAt,
  effectiveAt,
  updatedAt,
  expiresAt
}: AlertTimelineProps) {
  return (
    <div className="alert-detail-time-grid">
      <article>
        <h3>Issued</h3>
        <p>{formatDateTime(issuedAt)}</p>
      </article>
      <article>
        <h3>Effective</h3>
        <p>{formatDateTime(effectiveAt)}</p>
      </article>
      <article>
        <h3>Updated</h3>
        <p>{formatDateTime(updatedAt)}</p>
      </article>
      <article>
        <h3>Expires</h3>
        <p>{formatDateTime(expiresAt)}</p>
      </article>
      <AlertCountdown expiresAt={expiresAt} />
    </div>
  );
}

