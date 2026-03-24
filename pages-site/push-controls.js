(function () {
  if (window.__pushControlsInitialized) return;
  window.__pushControlsInitialized = true;

  const PUSH_STATE_STORAGE_KEY = 'liveWeather:pushState';

  const STATE_CODE_TO_NAME = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
    FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
    LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
    SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
    WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  const ALL_STATE_CODES_50 = Object.keys(STATE_CODE_TO_NAME);

  const dom = {
    pushStateSelect: document.getElementById('pushStateSelect'),
    enablePushBtn: document.getElementById('enablePushBtn'),
    disablePushBtn: document.getElementById('disablePushBtn'),
    pushStatusText: document.getElementById('pushStatusText'),
  };

  if (!dom.pushStateSelect || !dom.enablePushBtn || !dom.disablePushBtn || !dom.pushStatusText) return;

  let pushPublicKeyCache = '';
  let swRegistrationPromise = null;

  function normalizeStateCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return STATE_CODE_TO_NAME[code] ? code : '';
  }

  function formatStateName(code) {
    const c = String(code || '').toUpperCase();
    return STATE_CODE_TO_NAME[c] || c || '';
  }

  function queryStateCode() {
    const state = new URLSearchParams(window.location.search).get('state');
    return normalizeStateCode(state);
  }

  function pushStatePreference() {
    const fromStorage = normalizeStateCode(localStorage.getItem(PUSH_STATE_STORAGE_KEY));
    if (fromStorage) return fromStorage;
    const fromQuery = queryStateCode();
    if (fromQuery) return fromQuery;
    return 'KY';
  }

  function buildPushStateSelect() {
    const options = ALL_STATE_CODES_50
      .slice()
      .sort((a, b) => formatStateName(a).localeCompare(formatStateName(b)))
      .map((code) => '<option value="' + code + '">' + formatStateName(code) + '</option>')
      .join('');

    dom.pushStateSelect.innerHTML = options;
    dom.pushStateSelect.value = pushStatePreference();
  }

  function pushSupported() {
    return window.isSecureContext
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }

  function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  }

  function isStandalonePwa() {
    const mediaStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const legacyStandalone = typeof navigator.standalone === 'boolean' ? navigator.standalone : false;
    return Boolean(mediaStandalone || legacyStandalone);
  }

  async function isBraveBrowser() {
    try {
      if (!navigator.brave || typeof navigator.brave.isBrave !== 'function') return false;
      return await navigator.brave.isBrave();
    } catch {
      return false;
    }
  }

  function setPushStatus(message, isError) {
    dom.pushStatusText.textContent = message;
    dom.pushStatusText.classList.toggle('error', Boolean(isError));
  }

  function base64UrlToUint8Array(base64Url) {
    const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4);
    const raw = atob(padded);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  async function ensureServiceWorkerRegistration() {
    if (!swRegistrationPromise) {
      swRegistrationPromise = navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(async () => await navigator.serviceWorker.ready);
    }
    return await swRegistrationPromise;
  }

  async function fetchPushPublicKey() {
    if (pushPublicKeyCache) return pushPublicKeyCache;
    const res = await fetch('/api/push/public-key', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.publicKey) {
      throw new Error(payload.error || 'Push public key is unavailable.');
    }
    pushPublicKeyCache = String(payload.publicKey);
    return pushPublicKeyCache;
  }

  async function savePushSubscription(subscription, stateCode) {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        stateCode,
        subscription: subscription.toJSON(),
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || 'Could not save push subscription.');
    }
  }

  async function removePushSubscription(endpoint) {
    const res = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Could not remove push subscription.');
    }
  }

  function setPushButtonsLoading(isLoading) {
    dom.enablePushBtn.disabled = isLoading;
    dom.disablePushBtn.disabled = isLoading;
  }

  async function syncExistingPushSubscription() {
    const stateCode = normalizeStateCode(dom.pushStateSelect.value) || pushStatePreference();
    localStorage.setItem(PUSH_STATE_STORAGE_KEY, stateCode);
    const registration = await ensureServiceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      setPushStatus('Push alerts are off for ' + formatStateName(stateCode) + '.');
      return false;
    }
    await savePushSubscription(subscription, stateCode);
    setPushStatus('Push alerts are on for ' + formatStateName(stateCode) + '.');
    return true;
  }

  async function enablePushAlerts() {
    const stateCode = normalizeStateCode(dom.pushStateSelect.value);
    if (!stateCode) {
      setPushStatus('Choose a valid state before enabling push alerts.', true);
      return;
    }
    localStorage.setItem(PUSH_STATE_STORAGE_KEY, stateCode);

    if (!pushSupported()) {
      setPushStatus('Push alerts are not supported on this browser/device.', true);
      return;
    }

    if (isIosDevice() && !isStandalonePwa()) {
      setPushStatus('On iPhone/iPad, install this app to Home Screen and open it from there before enabling push alerts.', true);
      return;
    }

    setPushButtonsLoading(true);
    try {
      const registration = await ensureServiceWorkerRegistration();
      let permission = Notification.permission;
      if (permission !== 'granted') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        setPushStatus('Notification permission was not granted.', true);
        return;
      }

      const publicKey = await fetchPushPublicKey();
      const appServerKey = base64UrlToUint8Array(publicKey);
      if (appServerKey.length !== 65 || appServerKey[0] !== 4) {
        throw new Error('Server VAPID public key format is invalid.');
      }

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey,
        });
      }

      await savePushSubscription(subscription, stateCode);
      setPushStatus('Push alerts are on for ' + formatStateName(stateCode) + '.');
    } catch (err) {
      const text = String(err);
      if (/AbortError/i.test(text)) {
        if (await isBraveBrowser()) {
          setPushStatus('Push subscription failed in Brave. Check Brave setting "Use Google services for push messaging", allow notifications for this site, then try again.', true);
        } else {
          setPushStatus('Push subscription failed. If on iPhone/iPad, open the installed Home Screen app first. Otherwise check notification and browser push permissions, then try again.', true);
        }
      } else {
        setPushStatus('Could not enable push alerts: ' + text, true);
      }
    } finally {
      setPushButtonsLoading(false);
    }
  }

  async function disablePushAlerts() {
    if (!pushSupported()) {
      setPushStatus('Push alerts are not supported on this browser/device.', true);
      return;
    }

    setPushButtonsLoading(true);
    try {
      const registration = await ensureServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setPushStatus('Push alerts are already off.');
        return;
      }

      await removePushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
      setPushStatus('Push alerts are off.');
    } catch (err) {
      setPushStatus('Could not turn off push alerts: ' + String(err), true);
    } finally {
      setPushButtonsLoading(false);
    }
  }

  async function initPushControls() {
    buildPushStateSelect();

    dom.pushStateSelect.addEventListener('change', async () => {
      const stateCode = normalizeStateCode(dom.pushStateSelect.value);
      if (!stateCode) return;
      localStorage.setItem(PUSH_STATE_STORAGE_KEY, stateCode);
      try {
        if (pushSupported()) {
          const registration = await ensureServiceWorkerRegistration();
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            await savePushSubscription(subscription, stateCode);
            setPushStatus('Push alerts are on for ' + formatStateName(stateCode) + '.');
            return;
          }
        }
        setPushStatus('State preference saved: ' + formatStateName(stateCode) + '. Push alerts are off.');
      } catch (err) {
        setPushStatus('Could not update state preference: ' + String(err), true);
      }
    });

    dom.enablePushBtn.addEventListener('click', async () => {
      await enablePushAlerts();
    });

    dom.disablePushBtn.addEventListener('click', async () => {
      await disablePushAlerts();
    });

    if (!pushSupported()) {
      dom.enablePushBtn.disabled = true;
      dom.disablePushBtn.disabled = true;
      setPushStatus('Push alerts require HTTPS and a supported browser.', true);
      return;
    }

    if (isIosDevice() && !isStandalonePwa()) {
      dom.enablePushBtn.disabled = true;
      dom.disablePushBtn.disabled = true;
      setPushStatus('On iPhone/iPad, add this site to Home Screen and open the installed app to enable push alerts.', true);
      return;
    }

    try {
      const enabled = await syncExistingPushSubscription();
      if (!enabled) {
        const stateCode = normalizeStateCode(dom.pushStateSelect.value) || pushStatePreference();
        setPushStatus('Push alerts are off for ' + formatStateName(stateCode) + '.');
      }
    } catch (err) {
      setPushStatus('Push setup issue: ' + String(err), true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void initPushControls();
    });
  } else {
    void initPushControls();
  }
})();
