import type { SavedPlace } from "../../../types";
import { PlaceManager } from "../../locations/components/PlaceManager";
import { NotificationCenter } from "../../notifications/components/NotificationCenter";

type InstallHint = {
  title: string;
  detail: string;
};

type SettingsPageProps = {
  places: SavedPlace[];
  activePlaceId: string | null;
  installPromptAvailable: boolean;
  isStandaloneInstalled: boolean;
  installStatusMessage: string | null;
  pwaUpdateAvailable: boolean;
  pwaOfflineReady: boolean;
  onInstallPwa: () => Promise<void>;
  onApplyUpdate: () => Promise<void>;
  onOpenAddPlaceModal: () => void;
  onEditPlace: (placeId: string) => void;
  onRemovePlace: (placeId: string) => void;
  onSetPrimaryPlace: (placeId: string) => void;
  onRenamePlace: (placeId: string, nextLabel: string) => void;
};

function detectInstallHint(): InstallHint {
  const userAgent =
    typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return {
      title: "iPhone or iPad",
      detail:
        "In Safari, use Share then Add to Home Screen. Push support depends on iOS and browser version."
    };
  }
  if (/android/.test(userAgent)) {
    return {
      title: "Android",
      detail:
        "Tap Install when prompted or open the browser menu and choose Install app / Add to Home screen."
    };
  }
  return {
    title: "Desktop Chrome or Edge",
    detail:
      "Use Install App here or click the install icon in the browser address bar for a standalone app window."
  };
}

export function SettingsPage({
  places,
  activePlaceId,
  installPromptAvailable,
  isStandaloneInstalled,
  installStatusMessage,
  pwaUpdateAvailable,
  pwaOfflineReady,
  onInstallPwa,
  onApplyUpdate,
  onOpenAddPlaceModal,
  onEditPlace,
  onRemovePlace,
  onSetPrimaryPlace,
  onRenamePlace
}: SettingsPageProps) {
  const activePlace = places.find((place) => place.id === activePlaceId || place.isPrimary);
  const installHint = detectInstallHint();
  const installDisabled = isStandaloneInstalled || !installPromptAvailable;

  return (
    <section className="more-panel" aria-labelledby="settings-page-title">
      <article className="more-card">
        <h2 id="settings-page-title">More</h2>
        <p className="more-copy">
          App setup and place preferences for fast, reliable alert delivery.
        </p>

        <div className="more-actions">
          <button
            type="button"
            className="save-location-btn"
            onClick={() => void onInstallPwa()}
            disabled={installDisabled}
            aria-label={
              isStandaloneInstalled
                ? "App is already installed"
                : "Install Live Weather Alerts app"
            }
          >
            {isStandaloneInstalled ? "Installed" : "Install App"}
          </button>
          {pwaUpdateAvailable ? (
            <button
              type="button"
              className="text-btn"
              onClick={() => void onApplyUpdate()}
            >
              Apply Update
            </button>
          ) : null}
          <button type="button" className="text-btn" onClick={onOpenAddPlaceModal}>
            Add Place
          </button>
        </div>

        {installStatusMessage ? (
          <p className="message offline-message" role="status" aria-live="polite">
            {installStatusMessage}
          </p>
        ) : null}

        <p className="more-note">
          {activePlace
            ? `Primary place: ${activePlace.label} (${activePlace.stateCode})`
            : "No primary place saved yet."}
        </p>
        {pwaOfflineReady ? (
          <p className="more-note">
            Offline cache is ready. Reopen the installed app to verify cached alerts and
            history fallback.
          </p>
        ) : null}
        {!isStandaloneInstalled && !installPromptAvailable ? (
          <p className="more-note">
            Install prompt is not currently available in this session.
          </p>
        ) : null}
        <div className="install-education-card" aria-label="Install help">
          <p className="install-education-title">Install guidance for {installHint.title}</p>
          <p className="install-education-copy">{installHint.detail}</p>
        </div>
      </article>

      <PlaceManager
        places={places}
        activePlaceId={activePlaceId}
        onAddPlace={onOpenAddPlaceModal}
        onEditPlace={onEditPlace}
        onRemovePlace={onRemovePlace}
        onSetPrimary={onSetPrimaryPlace}
        onRenamePlace={onRenamePlace}
      />

      <NotificationCenter places={places} activePlaceId={activePlaceId} />
    </section>
  );
}
