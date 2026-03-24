const STATE_STORAGE_KEY = 'liveWeather:selectedState';
const PUSH_STATE_STORAGE_KEY = 'liveWeather:pushState';

const STATE_CODE_TO_NAME = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const ALL_STATE_CODES_50 = Object.keys(STATE_CODE_TO_NAME);

const dom = {
  siteNav: document.querySelector('.site-nav'),
  totalCount: document.getElementById('totalCount'),
  lastSynced: document.getElementById('lastSynced'),
  warningCount: document.getElementById('warningCount'),
  watchCount: document.getElementById('watchCount'),
  otherCount: document.getElementById('otherCount'),
  syncWarning: document.getElementById('syncWarning'),
  searchInput: document.getElementById('searchInput'),
  levelFilter: document.getElementById('levelFilter'),
  stateFilter: document.getElementById('stateFilter'),
  clearFilters: document.getElementById('clearFilters'),
  quickButtons: Array.from(document.querySelectorAll('.chip-btn')),
  resultsCount: document.getElementById('resultsCount'),
  refreshPage: document.getElementById('refreshPage'),
  globalEmpty: document.getElementById('globalEmpty'),
  alertsGrid: document.getElementById('alertsGrid'),
  filterEmptyState: document.getElementById('filterEmptyState'),
  pushStateSelect: document.getElementById('pushStateSelect'),
  enablePushBtn: document.getElementById('enablePushBtn'),
  disablePushBtn: document.getElementById('disablePushBtn'),
  pushStatusText: document.getElementById('pushStatusText'),
};

let alertRows = [];
let pushPublicKeyCache = '';
let swRegistrationPromise = null;

function escHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(text) {
  return escHtml(text).replace(/\r?\n/g, '<br>');
}

function classifyAlert(event) {
  const e = String(event || '');
  if (/\bwarning\b/i.test(e)) return 'warning';
  if (/\bwatch\b/i.test(e)) return 'watch';
  return 'other';
}

function severityColor(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'extreme') return '#7b0000';
  if (s === 'severe') return '#cc0000';
  if (s === 'moderate') return '#e07000';
  if (s === 'minor') return '#b8a000';
  return '#555';
}

function severityRank(severity) {
  const s = String(severity || '').toLowerCase();
  if (s === 'extreme') return 0;
  if (s === 'severe') return 1;
  if (s === 'moderate') return 2;
  if (s === 'minor') return 3;
  return 4;
}

function levelInfo(level) {
  if (level === 'warning') return { label: 'Take Action Now', helper: 'Danger is happening or very close.' };
  if (level === 'watch') return { label: 'Be Ready', helper: 'Danger is possible. Prepare now.' };
  return { label: 'Stay Aware', helper: 'Keep checking updates and stay careful.' };
}

function summarizeArea(areaDesc, maxItems = 6) {
  const text = String(areaDesc || '').trim();
  if (!text) return 'Unknown area';
  const parts = text.split(/\s*;\s*|\s*,\s*/).map((v) => v.trim()).filter(Boolean);
  if (parts.length <= maxItems) return parts.join(', ');
  return parts.slice(0, maxItems).join(', ') + `, and ${parts.length - maxItems} more`;
}

function toTextMeaning(event) {
  const e = String(event || '').toLowerCase();
  if (e.includes('tornado')) return 'A tornado may happen soon, or may already be happening nearby.';
  if (e.includes('severe thunderstorm')) return 'A strong storm can bring dangerous wind and hail.';
  if (e.includes('flash flood') || e.includes('flood')) return 'Water can rise fast and make roads unsafe.';
  if (e.includes('winter') || e.includes('blizzard') || e.includes('ice') || e.includes('snow') || e.includes('freez')) return 'Snow or ice can make travel slippery and dangerous.';
  if (e.includes('hurricane') || e.includes('tropical storm') || e.includes('storm surge')) return 'Strong tropical weather can cause floods, wind damage, and power loss.';
  if (e.includes('heat')) return 'Very hot weather can make people sick quickly.';
  if (e.includes('wind chill') || e.includes('cold') || e.includes('freeze')) return 'Dangerous cold can hurt skin and make people sick quickly.';
  if (e.includes('air quality') || e.includes('smoke')) return 'Smoke or dirty air can make breathing harder.';
  if (e.includes('fog')) return 'Low visibility can make driving unsafe.';
  return 'Weather may become dangerous in this area.';
}

function quickSteps(event) {
  const e = String(event || '').toLowerCase();
  if (e.includes('tornado')) return [
    'Go to a small room inside on the lowest floor.',
    'Stay away from windows and outside walls.',
    'Cover your head and neck until danger passes.',
  ];
  if (e.includes('flash flood') || e.includes('flood')) return [
    'Move to higher ground now.',
    'Never drive through flooded roads.',
    'Keep children and pets away from fast water.',
  ];
  if (e.includes('severe thunderstorm')) return [
    'Go indoors and stay away from windows.',
    'Bring in loose outdoor items.',
    'Charge phones and keep a flashlight nearby.',
  ];
  if (e.includes('winter') || e.includes('blizzard') || e.includes('ice') || e.includes('snow') || e.includes('freez')) return [
    'Avoid travel if possible until roads improve.',
    'Wear warm layers and cover your hands and face.',
    'Keep a blanket, food, and charged phone nearby.',
  ];
  if (e.includes('hurricane') || e.includes('tropical storm') || e.includes('storm surge')) return [
    'Get your emergency bag ready now.',
    'Stay away from flood-prone roads and coastlines.',
    'Follow local evacuation orders right away.',
  ];
  if (e.includes('heat')) return [
    'Drink water often and stay in a cool place.',
    'Check on older adults, kids, and pets.',
    'Avoid hard outdoor work during peak heat.',
  ];
  if (e.includes('wind chill') || e.includes('cold') || e.includes('freeze')) return [
    'Wear layers and cover all exposed skin.',
    'Limit time outside, especially for children.',
    'Bring pets inside and protect pipes.',
  ];
  if (e.includes('air quality') || e.includes('smoke')) return [
    'Stay indoors with windows closed.',
    'Limit outdoor activity and exercise.',
    'Use clean indoor air if available.',
  ];
  if (e.includes('fog')) return [
    'Drive slowly with low-beam headlights.',
    'Leave extra distance between cars.',
    'Delay travel if visibility is very low.',
  ];
  return [
    'Keep phone weather alerts turned on.',
    'Know the safest indoor place for your family.',
    'Check on neighbors who may need help.',
  ];
}

function timeUntil(expiresIso) {
  const ms = new Date(expiresIso).getTime();
  if (Number.isNaN(ms)) return 'Unknown';
  const delta = ms - Date.now();
  if (delta <= 0) return 'Expired or ending now';
  const totalMinutes = Math.round(delta / 60000);
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'} left`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes === 0 ? `${totalHours} hour${totalHours === 1 ? '' : 's'} left` : `${totalHours}h ${remMinutes}m left`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours === 0 ? `${days} day${days === 1 ? '' : 's'} left` : `${days}d ${remHours}h left`;
}

function formatDateTime(value) {
  if (!value) return 'Unknown';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatStateName(code) {
  const c = String(code || '').toUpperCase();
  return STATE_CODE_TO_NAME[c] || c || '';
}

function normalizeStateCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return STATE_CODE_TO_NAME[code] ? code : '';
}

function queryStateCode() {
  const state = new URLSearchParams(window.location.search).get('state');
  return normalizeStateCode(state);
}

function initStateFilter() {
  const extras = Array.from(new Set(alertRows.map((a) => String(a.stateCode || '').toUpperCase()).filter(Boolean)));
  const allCodes = Array.from(new Set([...ALL_STATE_CODES_50, ...extras])).sort((a, b) => formatStateName(a).localeCompare(formatStateName(b)));
  const options = ['<option value="all">All states</option>']
    .concat(allCodes.map((code) => `<option value="${escHtml(code)}">${escHtml(formatStateName(code))}</option>`))
    .join('');
  dom.stateFilter.innerHTML = options;
  const requestedState = queryStateCode() || localStorage.getItem(STATE_STORAGE_KEY) || 'all';
  const hasRequested = Array.from(dom.stateFilter.options).some((opt) => opt.value === requestedState);
  dom.stateFilter.value = hasRequested ? requestedState : 'all';
  localStorage.setItem(STATE_STORAGE_KEY, String(dom.stateFilter.value || 'all'));
}

function updateQuickButtons(level) {
  dom.quickButtons.forEach((btn) => {
    const btnLevel = btn.getAttribute('data-level') || 'all';
    btn.classList.toggle('active', btnLevel === level);
  });
}

function sortAlerts(items) {
  return [...items].sort((a, b) => {
    const aLevel = classifyAlert(a.event);
    const bLevel = classifyAlert(b.event);
    const levelRank = (x) => (x === 'warning' ? 0 : x === 'watch' ? 1 : 2);
    const diffLevel = levelRank(aLevel) - levelRank(bLevel);
    if (diffLevel !== 0) return diffLevel;
    const diffSeverity = severityRank(a.severity) - severityRank(b.severity);
    if (diffSeverity !== 0) return diffSeverity;
    const aExp = a.expires ? new Date(a.expires).getTime() : Number.POSITIVE_INFINITY;
    const bExp = b.expires ? new Date(b.expires).getTime() : Number.POSITIVE_INFINITY;
    return aExp - bExp;
  });
}

function renderStats(items, lastPoll, syncError) {
  const warningCount = items.filter((a) => classifyAlert(a.event) === 'warning').length;
  const watchCount = items.filter((a) => classifyAlert(a.event) === 'watch').length;
  const otherCount = items.length - warningCount - watchCount;
  dom.totalCount.textContent = String(items.length);
  dom.warningCount.textContent = String(warningCount);
  dom.watchCount.textContent = String(watchCount);
  dom.otherCount.textContent = String(otherCount);
  dom.lastSynced.textContent = lastPoll ? formatDateTime(lastPoll) : 'Unknown';
  if (syncError) {
    dom.syncWarning.hidden = false;
    dom.syncWarning.textContent = `Sync warning: ${syncError}`;
  } else {
    dom.syncWarning.hidden = true;
    dom.syncWarning.textContent = '';
  }
}

function renderAlerts() {
  const needle = String(dom.searchInput.value || '').trim().toLowerCase();
  const level = String(dom.levelFilter.value || 'all');
  const state = String(dom.stateFilter.value || 'all');

  const visible = sortAlerts(alertRows).filter((alert) => {
    const alertLevel = classifyAlert(alert.event);
    const alertState = String(alert.stateCode || '').toUpperCase();
    const searchText = `${alert.event} ${alert.areaDesc} ${alert.headline} ${alert.description} ${alert.instruction} ${formatStateName(alertState)} ${alertState}`.toLowerCase();
    const matchesLevel = level === 'all' || alertLevel === level;
    const matchesState = state === 'all' || alertState === state;
    const matchesSearch = !needle || searchText.includes(needle);
    return matchesLevel && matchesState && matchesSearch;
  });

  dom.resultsCount.textContent = visible.length === 1
    ? 'Showing 1 alert'
    : `Showing ${visible.length} alerts`;

  dom.filterEmptyState.hidden = visible.length !== 0 || alertRows.length === 0;
  dom.globalEmpty.hidden = alertRows.length !== 0;

  if (visible.length === 0) {
    dom.alertsGrid.innerHTML = '';
    return;
  }

  const cardsHtml = visible.map((alert, idx) => {
    const level = classifyAlert(alert.event);
    const info = levelInfo(level);
    const stateName = formatStateName(alert.stateCode);
    const summaryArea = summarizeArea(alert.areaDesc);
    const stepsHtml = quickSteps(alert.event).map((s) => `<li>${escHtml(s)}</li>`).join('');
    const nwsLink = alert.nwsUrl
      ? `<a class="nws-link" href="${escHtml(alert.nwsUrl)}" target="_blank" rel="noopener noreferrer">View official NWS alert</a>`
      : '';
    const headlineHtml = alert.headline ? `<p class="headline">${escHtml(alert.headline)}</p>` : '';
    const descriptionHtml = alert.description
      ? `<p class="detail-copy">${nl2br(alert.description)}</p>`
      : '<p class="detail-copy muted">No extra details were provided.</p>';
    const instructionHtml = alert.instruction
      ? `<p class="detail-copy">${nl2br(alert.instruction)}</p>`
      : '<p class="detail-copy muted">No special actions were provided.</p>';
    const delay = Math.min(idx * 0.05, 0.7).toFixed(2);

    return `
      <article class="alert-card level-${escHtml(level)}" style="animation-delay:${delay}s">
        <div class="card-top">
          <div class="pill-row">
            <span class="level-pill level-${escHtml(level)}">${escHtml(info.label)}</span>
            <span class="severity-pill" style="background:${escHtml(severityColor(alert.severity))}">${escHtml(String(alert.severity || 'Unknown').toUpperCase())}</span>
            ${stateName ? `<span class="state-chip">${escHtml(stateName)}</span>` : ''}
          </div>
          <h2>${escHtml(alert.event || 'Weather Alert')}</h2>
          <p class="area-line">${escHtml(summaryArea)}</p>
          ${headlineHtml}
        </div>
        <div class="plain-meaning">
          <h3>What this means</h3>
          <p>${escHtml(toTextMeaning(alert.event))}</p>
          <p class="helper">${escHtml(info.helper)}</p>
        </div>
        <div class="quick-steps">
          <h3>What to do now</h3>
          <ul>${stepsHtml}</ul>
        </div>
        <div class="time-grid">
          <p><span>Issued</span><strong>${escHtml(formatDateTime(alert.sent || alert.effective))}</strong></p>
          <p><span>Expires</span><strong>${escHtml(formatDateTime(alert.expires))}</strong></p>
          <p><span>Time left</span><strong>${escHtml(timeUntil(alert.expires))}</strong></p>
        </div>
        <details class="details-block">
          <summary>Read full details</summary>
          <div class="details-content">
            <p class="detail-label">Affected Areas</p>
            <p class="detail-copy">${escHtml(alert.areaDesc || 'Unknown area')}</p>
            <p class="detail-label">Description</p>
            ${descriptionHtml}
            <p class="detail-label">Instructions</p>
            ${instructionHtml}
            ${nwsLink}
          </div>
        </details>
      </article>
    `;
  }).join('');

  dom.alertsGrid.innerHTML = cardsHtml;
}

async function fetchAlerts() {
  const endpoints = ['/api/alerts', 'https://live-weather.jamesbrock25.workers.dev/api/alerts'];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!res.ok) {
        errors.push(`${endpoint} (${res.status})`);
        continue;
      }
      return await res.json();
    } catch (err) {
      errors.push(`${endpoint} (${String(err)})`);
    }
  }
  throw new Error(`Unable to load alerts from API. Tried: ${errors.join(', ')}`);
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

function setPushStatus(message, isError = false) {
  if (!dom.pushStatusText) return;
  dom.pushStatusText.textContent = message;
  dom.pushStatusText.classList.toggle('error', Boolean(isError));
}

function pushStatePreference() {
  const fromStorage = normalizeStateCode(localStorage.getItem(PUSH_STATE_STORAGE_KEY));
  if (fromStorage) return fromStorage;
  const fromQuery = queryStateCode();
  if (fromQuery) return fromQuery;
  const selectedMainState = normalizeStateCode(dom.stateFilter?.value);
  if (selectedMainState) return selectedMainState;
  return 'KY';
}

function buildPushStateSelect() {
  if (!dom.pushStateSelect) return;
  const options = ALL_STATE_CODES_50
    .slice()
    .sort((a, b) => formatStateName(a).localeCompare(formatStateName(b)))
    .map((code) => `<option value="${escHtml(code)}">${escHtml(formatStateName(code))}</option>`)
    .join('');
  dom.pushStateSelect.innerHTML = options;
  dom.pushStateSelect.value = pushStatePreference();
}

function base64UrlToUint8Array(base64Url) {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (base64Url.length % 4)) % 4);
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
  return payload;
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
  if (dom.enablePushBtn) dom.enablePushBtn.disabled = isLoading;
  if (dom.disablePushBtn) dom.disablePushBtn.disabled = isLoading;
}

async function syncExistingPushSubscription() {
  const stateCode = normalizeStateCode(dom.pushStateSelect?.value) || pushStatePreference();
  localStorage.setItem(PUSH_STATE_STORAGE_KEY, stateCode);
  const registration = await ensureServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    setPushStatus(`Push alerts are off for ${formatStateName(stateCode)}.`);
    return false;
  }
  await savePushSubscription(subscription, stateCode);
  setPushStatus(`Push alerts are on for ${formatStateName(stateCode)}.`);
  return true;
}

async function enablePushAlerts() {
  const stateCode = normalizeStateCode(dom.pushStateSelect?.value);
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
    setPushStatus(`Push alerts are on for ${formatStateName(stateCode)}.`);
  } catch (err) {
    const text = String(err);
    if (/AbortError/i.test(text)) {
      if (await isBraveBrowser()) {
        setPushStatus('Push subscription failed in Brave. Check Brave setting "Use Google services for push messaging", allow notifications for this site, then try again.', true);
      } else {
        setPushStatus('Push subscription failed. If on iPhone/iPad, open the installed Home Screen app first. Otherwise check notification and browser push permissions, then try again.', true);
      }
    } else {
      setPushStatus(`Could not enable push alerts: ${text}`, true);
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
    setPushStatus(`Could not turn off push alerts: ${String(err)}`, true);
  } finally {
    setPushButtonsLoading(false);
  }
}

async function initPushControls() {
  if (!dom.pushStateSelect || !dom.enablePushBtn || !dom.disablePushBtn || !dom.pushStatusText) return;
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
          setPushStatus(`Push alerts are on for ${formatStateName(stateCode)}.`);
          return;
        }
      }
      setPushStatus(`State preference saved: ${formatStateName(stateCode)}. Push alerts are off.`);
    } catch (err) {
      setPushStatus(`Could not update state preference: ${String(err)}`, true);
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
      setPushStatus(`Push alerts are off for ${formatStateName(stateCode)}.`);
    }
  } catch (err) {
    setPushStatus(`Push setup issue: ${String(err)}`, true);
  }
}

function bindEvents() {
  dom.quickButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const level = btn.getAttribute('data-level') || 'all';
      dom.levelFilter.value = level;
      updateQuickButtons(level);
      renderAlerts();
    });
  });

  dom.searchInput.addEventListener('input', () => {
    updateQuickButtons(String(dom.levelFilter.value || 'all'));
    renderAlerts();
  });

  dom.levelFilter.addEventListener('change', () => {
    updateQuickButtons(String(dom.levelFilter.value || 'all'));
    renderAlerts();
  });

  dom.stateFilter.addEventListener('change', () => {
    localStorage.setItem(STATE_STORAGE_KEY, String(dom.stateFilter.value || 'all'));
    renderAlerts();
  });

  dom.clearFilters.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.levelFilter.value = 'all';
    updateQuickButtons('all');
    renderAlerts();
    dom.searchInput.focus();
  });

  dom.refreshPage.addEventListener('click', () => {
    window.location.reload();
  });
}

async function boot() {
  try {
    if (dom.siteNav) dom.siteNav.scrollLeft = 0;
    const payload = await fetchAlerts();
    alertRows = Array.isArray(payload.alerts) ? payload.alerts : [];
    renderStats(alertRows, payload.lastPoll, payload.syncError);
    initStateFilter();
    bindEvents();
    updateQuickButtons(String(dom.levelFilter.value || 'all'));
    renderAlerts();
  } catch (err) {
    dom.resultsCount.textContent = 'Could not load weather alerts right now.';
    dom.globalEmpty.hidden = false;
    dom.globalEmpty.querySelector('h2').textContent = 'Unable to load alerts';
    dom.globalEmpty.querySelector('p').textContent = String(err);
  } finally {
    await initPushControls();
  }
}

boot();
