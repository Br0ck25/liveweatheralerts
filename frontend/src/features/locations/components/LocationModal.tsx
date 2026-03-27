import { useEffect, useRef, type FormEvent } from "react";
import { PLACE_LABEL_PRESETS, type PlaceLabelPreset } from "../../../lib/storage/places";

type LocationModalMode = "add" | "edit";

type LocationModalProps = {
  isOpen: boolean;
  mode: LocationModalMode;
  placeLabel: string;
  placeLabelPreset: PlaceLabelPreset;
  locationInput: string;
  locationError: string | null;
  isSavingLocation: boolean;
  onPlaceLabelPresetChange: (value: PlaceLabelPreset) => void;
  onPlaceLabelChange: (value: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
};

export function LocationModal({
  isOpen,
  mode,
  placeLabel,
  placeLabelPreset,
  locationInput,
  locationError,
  isSavingLocation,
  onPlaceLabelPresetChange,
  onPlaceLabelChange,
  onInputChange,
  onSubmit,
  onClose
}: LocationModalProps) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = window.setTimeout(() => {
      firstInputRef.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <section
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="location-modal-title"
      aria-describedby="location-modal-description"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isSavingLocation) {
          onClose();
        }
      }}
    >
      <div className="location-modal">
        <p className="modal-eyebrow">
          {mode === "edit" ? "Update saved place" : "Add a place"}
        </p>
        <h2 id="location-modal-title">
          {mode === "edit" ? "Edit this place" : "Where should we focus alerts?"}
        </h2>
        <p className="modal-copy" id="location-modal-description">
          Enter <strong>City, State</strong>, <strong>State</strong>, or{" "}
          <strong>ZIP code</strong>. Places are saved in your browser, and the
          primary place drives alerts and forecast context.
        </p>

        <form className="location-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Place preset</span>
            <select
              value={placeLabelPreset}
              onChange={(event) =>
                onPlaceLabelPresetChange(event.target.value as PlaceLabelPreset)
              }
            >
              {PLACE_LABEL_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
              <option value="Custom">Custom</option>
            </select>
          </label>

          <label className="field">
            <span>Place label</span>
            <input
              ref={firstInputRef}
              value={placeLabel}
              onChange={(inputEvent) => onPlaceLabelChange(inputEvent.target.value)}
              placeholder="Example: Home"
            />
          </label>

          <label className="field">
            <span>Location</span>
            <input
              value={locationInput}
              onChange={(inputEvent) => onInputChange(inputEvent.target.value)}
              placeholder="Examples: Columbus, OH · Ohio · 43215"
            />
          </label>

          {locationError ? (
            <p className="modal-error" role="alert">
              {locationError}
            </p>
          ) : null}

          <div className="modal-actions">
            <button
              type="submit"
              className="save-location-btn"
              disabled={isSavingLocation}
            >
              {isSavingLocation
                ? "Saving..."
                : mode === "edit"
                  ? "Save Place Changes"
                  : "Save Place"}
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={isSavingLocation}
              onClick={onClose}
            >
              {mode === "edit" ? "Cancel" : "Skip for now"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
