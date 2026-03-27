import { useMemo, type ChangeEvent } from "react";
import { usePushNotifications } from "../hooks/usePushNotifications";
import type { PushScope, SavedPlace } from "../../../types";

type NotificationCenterProps = {
  places: SavedPlace[];
  activePlaceId: string | null;
};

function permissionLabel(permission: NotificationPermission | "unsupported"): string {
  if (permission === "granted") return "Granted";
  if (permission === "denied") return "Blocked";
  if (permission === "default") return "Not requested";
  return "Unsupported";
}

function normalizeStateInput(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2);
}

function normalizeCountyFipsInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 3);
}

export function NotificationCenter({ places, activePlaceId }: NotificationCenterProps) {
  const {
    supported,
    permission,
    isSubscribed,
    prefs,
    placeScopes,
    customScopes,
    setPrefs,
    isLoading,
    isSaving,
    isSendingTest,
    error,
    notice,
    subscribe,
    unsubscribe,
    savePreferences,
    sendTestNotification,
    addScope,
    removeScope,
    placeHasCountyData
  } = usePushNotifications(places, activePlaceId);

  const placeById = useMemo(() => {
    return new Map(places.map((place) => [place.id, place]));
  }, [places]);

  const updateScope = (
    scopeId: string,
    updater: (scope: PushScope) => PushScope
  ) => {
    setPrefs((current) => ({
      ...current,
      scopes: current.scopes.map((scope) =>
        scope.id === scopeId ? updater(scope) : scope
      )
    }));
  };

  const onScopeStateCodeChange = (scopeId: string, event: ChangeEvent<HTMLInputElement>) => {
    const nextStateCode = normalizeStateInput(event.target.value);
    updateScope(scopeId, (scope) => ({
      ...scope,
      stateCode: nextStateCode || scope.stateCode
    }));
  };

  const onScopeDeliveryScopeChange = (
    scopeId: string,
    event: ChangeEvent<HTMLSelectElement>
  ) => {
    const deliveryScope = event.target.value === "county" ? "county" : "state";
    updateScope(scopeId, (scope) => ({
      ...scope,
      deliveryScope,
      countyName: deliveryScope === "county" ? scope.countyName : null,
      countyFips: deliveryScope === "county" ? scope.countyFips : null
    }));
  };

  const onScopeAlertTypeChange = (
    scopeId: string,
    key: keyof PushScope["alertTypes"],
    checked: boolean
  ) => {
    updateScope(scopeId, (scope) => ({
      ...scope,
      alertTypes: {
        ...scope.alertTypes,
        [key]: checked
      }
    }));
  };

  return (
    <section className="notification-card" aria-labelledby="notification-center-title">
      <header className="notification-header">
        <div>
          <h3 id="notification-center-title">Notification Center</h3>
          <p>
            Enable browser push alerts, tune per-place coverage, and test delivery
            from this device.
          </p>
        </div>
        <div className="notification-status">
          <strong>{isSubscribed ? "Enabled" : "Disabled"}</strong>
          <span>Permission: {permissionLabel(permission)}</span>
        </div>
      </header>

      {!supported ? (
        <p className="more-note">
          Push notifications are not supported in this browser. Use a recent Chrome, Edge,
          or another PWA-capable browser to receive alert notifications.
        </p>
      ) : null}

      {isLoading ? <p className="more-note">Checking browser notification support...</p> : null}
      {error ? (
        <p className="message error-message" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="message offline-message" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <div className="notification-actions">
        <button
          type="button"
          className="save-location-btn"
          onClick={() => void subscribe()}
          disabled={!supported || isSaving || isSubscribed}
        >
          Enable Notifications
        </button>
        <button
          type="button"
          className="text-btn"
          onClick={() => void unsubscribe()}
          disabled={!supported || isSaving || !isSubscribed}
        >
          Disable Notifications
        </button>
      </div>

      <div className="notification-section">
        <h4>Delivery Preferences</h4>
        <div className="field-grid notification-grid">
          <label className="field">
            <span>Delivery Mode</span>
            <select
              value={prefs.deliveryMode}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  deliveryMode: event.target.value === "digest" ? "digest" : "immediate"
                }))
              }
            >
              <option value="immediate">Immediate</option>
              <option value="digest">Digest (grouped lifecycle updates)</option>
            </select>
          </label>

          <label className="field notification-toggle">
            <span>Quiet Hours</span>
            <input
              type="checkbox"
              checked={prefs.quietHours.enabled}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  quietHours: {
                    ...current.quietHours,
                    enabled: event.target.checked
                  }
                }))
              }
            />
          </label>

          <label className="field">
            <span>Quiet Start</span>
            <input
              type="time"
              value={prefs.quietHours.start}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  quietHours: {
                    ...current.quietHours,
                    start: event.target.value
                  }
                }))
              }
            />
          </label>

          <label className="field">
            <span>Quiet End</span>
            <input
              type="time"
              value={prefs.quietHours.end}
              onChange={(event) =>
                setPrefs((current) => ({
                  ...current,
                  quietHours: {
                    ...current.quietHours,
                    end: event.target.value
                  }
                }))
              }
            />
          </label>
        </div>
      </div>

      <div className="notification-section">
        <h4>Per-Place Notification Scopes</h4>
        {placeScopes.length === 0 ? (
          <p className="more-note">
            Add places to enable place-aware notification scope controls.
          </p>
        ) : (
          <div className="notification-scope-list">
            {placeScopes.map((scope) => {
              const place = scope.placeId ? placeById.get(scope.placeId) : undefined;
              const countyAllowed = Boolean(place && placeHasCountyData(place));
              const placeLabel = place?.label || scope.label;
              return (
                <article key={scope.id} className="notification-scope-card">
                  <div className="notification-scope-top">
                    <label className="field">
                      <span>Place</span>
                      <input type="text" value={placeLabel} readOnly />
                    </label>

                    <label className="field">
                      <span>State</span>
                      <input type="text" value={scope.stateCode} readOnly />
                    </label>

                    <label className="field">
                      <span>Scope Type</span>
                      <select
                        value={scope.deliveryScope}
                        onChange={(event) => onScopeDeliveryScopeChange(scope.id, event)}
                        disabled={!countyAllowed}
                      >
                        <option value="state">State</option>
                        <option value="county">County</option>
                      </select>
                    </label>
                  </div>

                  {scope.deliveryScope === "county" ? (
                    <div className="field-grid notification-grid">
                      <label className="field">
                        <span>County Name</span>
                        <input type="text" value={scope.countyName || ""} readOnly />
                      </label>
                      <label className="field">
                        <span>County FIPS</span>
                        <input type="text" value={scope.countyFips || ""} readOnly />
                      </label>
                    </div>
                  ) : null}

                  {!countyAllowed ? (
                    <p className="more-note">
                      County-level follow becomes available when this place has county data.
                    </p>
                  ) : null}

                  <div className="notification-toggle-row">
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.enabled}
                        onChange={(event) =>
                          updateScope(scope.id, (current) => ({
                            ...current,
                            enabled: event.target.checked
                          }))
                        }
                      />
                      Enabled
                    </label>
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.severeOnly}
                        onChange={(event) =>
                          updateScope(scope.id, (current) => ({
                            ...current,
                            severeOnly: event.target.checked
                          }))
                        }
                      />
                      Severe only
                    </label>
                  </div>

                  <div className="notification-type-grid">
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.alertTypes.warnings}
                        onChange={(event) =>
                          onScopeAlertTypeChange(scope.id, "warnings", event.target.checked)
                        }
                      />
                      Warnings
                    </label>
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.alertTypes.watches}
                        onChange={(event) =>
                          onScopeAlertTypeChange(scope.id, "watches", event.target.checked)
                        }
                      />
                      Watches
                    </label>
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.alertTypes.advisories}
                        onChange={(event) =>
                          onScopeAlertTypeChange(scope.id, "advisories", event.target.checked)
                        }
                      />
                      Advisories
                    </label>
                    <label className="notification-check">
                      <input
                        type="checkbox"
                        checked={scope.alertTypes.statements}
                        onChange={(event) =>
                          onScopeAlertTypeChange(scope.id, "statements", event.target.checked)
                        }
                      />
                      Statements
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="notification-section">
        <div className="notification-scopes-header">
          <h4>Additional Custom Scopes</h4>
          <button
            type="button"
            className="text-btn"
            onClick={addScope}
            aria-label="Add a custom notification scope"
          >
            Add Scope
          </button>
        </div>

        <div className="notification-scope-list">
          {customScopes.map((scope) => (
            <article key={scope.id} className="notification-scope-card">
              <div className="notification-scope-top">
                <label className="field">
                  <span>Scope Label</span>
                  <input
                    type="text"
                    value={scope.label}
                    onChange={(event) =>
                      updateScope(scope.id, (current) => ({
                        ...current,
                        label: event.target.value
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>State</span>
                  <input
                    type="text"
                    value={scope.stateCode}
                    onChange={(event) => onScopeStateCodeChange(scope.id, event)}
                    placeholder="KY"
                  />
                </label>

                <label className="field">
                  <span>Scope Type</span>
                  <select
                    value={scope.deliveryScope}
                    onChange={(event) => onScopeDeliveryScopeChange(scope.id, event)}
                  >
                    <option value="state">State</option>
                    <option value="county">County</option>
                  </select>
                </label>
              </div>

              {scope.deliveryScope === "county" ? (
                <div className="field-grid notification-grid">
                  <label className="field">
                    <span>County Name</span>
                    <input
                      type="text"
                      value={scope.countyName || ""}
                      onChange={(event) =>
                        updateScope(scope.id, (current) => ({
                          ...current,
                          countyName: event.target.value || null
                        }))
                      }
                      placeholder="Jefferson County"
                    />
                  </label>
                  <label className="field">
                    <span>County FIPS</span>
                    <input
                      type="text"
                      value={scope.countyFips || ""}
                      onChange={(event) =>
                        updateScope(scope.id, (current) => ({
                          ...current,
                          countyFips:
                            normalizeCountyFipsInput(event.target.value) || null
                        }))
                      }
                      placeholder="111"
                    />
                  </label>
                </div>
              ) : null}

              <div className="notification-toggle-row">
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.enabled}
                    onChange={(event) =>
                      updateScope(scope.id, (current) => ({
                        ...current,
                        enabled: event.target.checked
                      }))
                    }
                  />
                  Enabled
                </label>
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.severeOnly}
                    onChange={(event) =>
                      updateScope(scope.id, (current) => ({
                        ...current,
                        severeOnly: event.target.checked
                      }))
                    }
                  />
                  Severe only
                </label>
              </div>

              <div className="notification-type-grid">
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.alertTypes.warnings}
                    onChange={(event) =>
                      onScopeAlertTypeChange(scope.id, "warnings", event.target.checked)
                    }
                  />
                  Warnings
                </label>
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.alertTypes.watches}
                    onChange={(event) =>
                      onScopeAlertTypeChange(scope.id, "watches", event.target.checked)
                    }
                  />
                  Watches
                </label>
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.alertTypes.advisories}
                    onChange={(event) =>
                      onScopeAlertTypeChange(scope.id, "advisories", event.target.checked)
                    }
                  />
                  Advisories
                </label>
                <label className="notification-check">
                  <input
                    type="checkbox"
                    checked={scope.alertTypes.statements}
                    onChange={(event) =>
                      onScopeAlertTypeChange(scope.id, "statements", event.target.checked)
                    }
                  />
                  Statements
                </label>
              </div>

              <div className="notification-scope-actions">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => removeScope(scope.id)}
                  disabled={customScopes.length <= 1}
                >
                  Remove Scope
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="notification-actions">
        <button
          type="button"
          className="save-location-btn"
          onClick={() => void savePreferences()}
          disabled={!supported || isSaving}
        >
          Save Notification Settings
        </button>
        <button
          type="button"
          className="text-btn"
          onClick={() => void sendTestNotification()}
          disabled={!supported || !isSubscribed || isSendingTest}
        >
          Send Test Notification
        </button>
      </div>
    </section>
  );
}
