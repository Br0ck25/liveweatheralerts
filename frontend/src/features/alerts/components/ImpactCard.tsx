import type { AlertImpactCardModel } from "../utils";

type ImpactCardProps = {
  card: AlertImpactCardModel;
  className?: string;
};

export function ImpactCard({ card, className = "" }: ImpactCardProps) {
  return (
    <article className={`impact-card impact-card-${card.tone} ${className}`.trim()}>
      <h3>{card.title}</h3>
      <p className="impact-card-detail">{card.detail}</p>
      <p className="impact-card-action">
        <strong>Do now:</strong> {card.action}
      </p>
    </article>
  );
}

