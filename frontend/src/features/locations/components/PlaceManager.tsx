import type { SavedPlace } from "../../../types";
import { PLACE_LABEL_PRESETS } from "../../../lib/storage/places";

type PlaceManagerProps = {
  places: SavedPlace[];
  activePlaceId: string | null;
  onAddPlace: () => void;
  onEditPlace: (placeId: string) => void;
  onRemovePlace: (placeId: string) => void;
  onSetPrimary: (placeId: string) => void;
  onRenamePlace: (placeId: string, nextLabel: string) => void;
};

function countySummary(place: SavedPlace): string {
  if (place.countyName && place.countyCode) {
    return `${place.countyName} (${place.countyCode})`;
  }
  if (place.countyName) return place.countyName;
  if (place.countyCode) return `County code ${place.countyCode}`;
  return "State-wide scope";
}

export function PlaceManager({
  places,
  activePlaceId,
  onAddPlace,
  onEditPlace,
  onRemovePlace,
  onSetPrimary,
  onRenamePlace
}: PlaceManagerProps) {
  return (
    <section className="place-manager-card" aria-labelledby="place-manager-title">
      <header className="place-manager-header">
        <div>
          <h3 id="place-manager-title">Places</h3>
          <p>Manage Home, Work, Family, Travel, and custom places.</p>
        </div>
        <button type="button" className="save-location-btn" onClick={onAddPlace}>
          Add Place
        </button>
      </header>

      {places.length === 0 ? (
        <p className="more-note">
          No saved places yet. Add one to target alerts, forecast, and notifications.
        </p>
      ) : (
        <div className="place-manager-list">
          {places.map((place) => {
            const isActive = place.id === activePlaceId || place.isPrimary;
            return (
              <article key={place.id} className="place-manager-item">
                <div className="place-manager-item-head">
                  <p className="place-manager-item-location">{place.rawInput}</p>
                  <span
                    className={`place-manager-item-badge${
                      isActive ? " place-manager-item-badge-primary" : ""
                    }`}
                  >
                    {isActive ? "Primary" : "Secondary"}
                  </span>
                </div>

                <label className="field">
                  <span>Label</span>
                  <input
                    type="text"
                    value={place.label}
                    onChange={(event) => onRenamePlace(place.id, event.target.value)}
                  />
                </label>

                <div className="place-manager-presets" role="group" aria-label="Place label presets">
                  {PLACE_LABEL_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`place-preset-btn${
                        place.label.trim().toLowerCase() === preset.toLowerCase()
                          ? " active"
                          : ""
                      }`}
                      onClick={() => onRenamePlace(place.id, preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>

                <p className="place-manager-meta">
                  {place.stateCode} - {countySummary(place)}
                </p>

                <div className="place-manager-actions">
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => onSetPrimary(place.id)}
                    disabled={isActive}
                    aria-label={`Set ${place.label} as primary place`}
                  >
                    Set Primary
                  </button>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => onEditPlace(place.id)}
                    aria-label={`Edit ${place.label}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => onRemovePlace(place.id)}
                    disabled={places.length <= 1}
                    aria-label={`Remove ${place.label}`}
                  >
                    Remove
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
