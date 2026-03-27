type AlertActionToolsProps = {
  onShare: () => void;
  onCopyLink: () => void;
  onCopySafetySteps: () => void;
  onOpenRadar: () => void;
};

export function AlertActionTools({
  onShare,
  onCopyLink,
  onCopySafetySteps,
  onOpenRadar
}: AlertActionToolsProps) {
  return (
    <div className="alert-action-tools" role="group" aria-label="Alert actions">
      <button type="button" className="text-btn" onClick={onShare}>
        Share
      </button>
      <button type="button" className="text-btn" onClick={onCopyLink}>
        Copy link
      </button>
      <button type="button" className="text-btn" onClick={onCopySafetySteps}>
        Copy safety steps
      </button>
      <button type="button" className="text-btn" onClick={onOpenRadar}>
        View radar
      </button>
    </div>
  );
}
