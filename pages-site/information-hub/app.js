const tabs = Array.from(document.querySelectorAll('.hub-tab'));
const panels = Array.from(document.querySelectorAll('.hub-panel'));
const FORECAST_STORAGE_KEY = 'lwa_saved_zip';
const DEGREE_SYMBOL = '\u00B0';

const forecastDom = {
  form: document.getElementById('forecastForm'),
  zipInput: document.getElementById('forecastZipInput'),
  submitBtn: document.getElementById('forecastSubmitBtn'),
  status: document.getElementById('forecastStatus'),
  error: document.getElementById('forecastError'),
  results: document.getElementById('forecastResults'),
  currentSummary: document.getElementById('forecastCurrentSummary'),
  todaySummary: document.getElementById('forecastTodaySummary'),
  radarImage: document.getElementById('forecastRadarImage'),
  mapFallback: document.getElementById('forecastMapFallback'),
  radarLink: document.getElementById('forecastRadarLink'),
  hourlyList: document.getElementById('forecastHourlyList'),
  dailyList: document.getElementById('forecastDailyList'),
};

let forecastRequestId = 0;

function activateTab(tab, options = {}) {
  const { updateUrl = true } = options;
  const target = tab.dataset.panel;
  if (!target) return;

  tabs.forEach((candidate) => {
    const isActive = candidate === tab;
    candidate.classList.toggle('is-active', isActive);
    candidate.setAttribute('aria-selected', isActive ? 'true' : 'false');
    candidate.tabIndex = isActive ? 0 : -1;
  });

  panels.forEach((panel) => {
    const isActive = panel.id === `panel-${target}`;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });

  if (updateUrl && typeof window !== 'undefined' && typeof history !== 'undefined') {
    const url = new URL(window.location.href);
    if (target === 'start') {
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', target);
    }
    history.replaceState(null, '', url.toString());
  }
}

function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Time n/a';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
  });
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function getErrorMessage(err) {
  if (err && typeof err === 'object' && 'message' in err) {
    return String(err.message || 'Unable to load forecast right now.');
  }
  return String(err || 'Unable to load forecast right now.');
}

function setForecastError(message) {
  if (!forecastDom.error || !forecastDom.status) return;
  forecastDom.error.hidden = false;
  forecastDom.error.textContent = message;
  forecastDom.status.textContent = 'Forecast unavailable right now.';
}

function clearForecastError() {
  if (!forecastDom.error) return;
  forecastDom.error.hidden = true;
  forecastDom.error.textContent = '';
}

function renderCurrentSummary(data) {
  if (!forecastDom.currentSummary) return;
  forecastDom.currentSummary.innerHTML = '';

  const locationLabel = `${data.location.city}${data.location.state ? `, ${data.location.state}` : ''} (${data.zip})`;
  forecastDom.currentSummary.appendChild(createElement('p', 'forecast-summary', locationLabel));

  const temp = data.current.temperature;
  const tempUnit = data.current.temperatureUnit || 'F';
  const feels = data.current.feelsLike;
  const feelsUnit = data.current.feelsLikeUnit || 'F';
  forecastDom.currentSummary.appendChild(createElement('p', 'forecast-temp-line', `${temp ?? '--'}${DEGREE_SYMBOL}${tempUnit}`));
  forecastDom.currentSummary.appendChild(createElement('p', 'forecast-summary', `Feels like: ${feels ?? '--'}${DEGREE_SYMBOL}${feelsUnit}`));
  forecastDom.currentSummary.appendChild(createElement('p', 'forecast-summary', data.current.condition || 'Condition unavailable'));
  if (data.current.humidity !== null && data.current.humidity !== undefined) {
    forecastDom.currentSummary.appendChild(createElement('p', 'forecast-summary', `Humidity: ${Math.round(data.current.humidity)}%`));
  }
  forecastDom.currentSummary.appendChild(createElement('p', 'forecast-summary', `Wind: ${data.current.wind || 'Not available'}`));
}

function renderTodaySummary(data) {
  if (!forecastDom.todaySummary) return;
  forecastDom.todaySummary.innerHTML = '';
  forecastDom.todaySummary.appendChild(createElement('p', 'forecast-temp-line', `High ${data.today.high ?? '--'}${DEGREE_SYMBOL}F / Low ${data.today.low ?? '--'}${DEGREE_SYMBOL}F`));
  forecastDom.todaySummary.appendChild(createElement('p', 'forecast-summary', `Updated: ${formatDateTime(data.updatedAt)}`));
}

function renderRadar(data) {
  if (!forecastDom.radarImage || !forecastDom.radarLink || !forecastDom.mapFallback) return;
  const radarUrl = data?.map?.radarLoopUrl || '';
  const radarPageUrl = data?.map?.radarPageUrl || 'https://radar.weather.gov/';
  const mapClickUrl = data?.map?.mapClickUrl || radarPageUrl;
  forecastDom.radarLink.href = radarPageUrl;
  forecastDom.radarLink.textContent = 'Open interactive radar';
  forecastDom.radarLink.title = mapClickUrl;

  if (radarUrl) {
    forecastDom.radarImage.onerror = () => {
      forecastDom.radarImage.hidden = true;
      forecastDom.mapFallback.hidden = false;
      forecastDom.mapFallback.textContent = 'Radar image is unavailable right now. Use the interactive radar link.';
    };
    forecastDom.radarImage.src = radarUrl;
    forecastDom.radarImage.hidden = false;
    forecastDom.mapFallback.hidden = true;
  } else {
    forecastDom.radarImage.removeAttribute('src');
    forecastDom.radarImage.hidden = true;
    forecastDom.mapFallback.hidden = false;
    forecastDom.mapFallback.textContent = 'Radar image not available for this location right now.';
  }
}

function renderHourly(data) {
  if (!forecastDom.hourlyList) return;
  forecastDom.hourlyList.innerHTML = '';
  const hours = Array.isArray(data.hourly) ? data.hourly : [];
  if (hours.length === 0) {
    forecastDom.hourlyList.appendChild(createElement('p', 'forecast-summary', 'Hourly forecast is unavailable.'));
    return;
  }

  for (const hour of hours) {
    const card = createElement('div', 'hourly-card');
    card.appendChild(createElement('p', 'hourly-time', formatShortTime(hour.startTime)));
    card.appendChild(createElement('p', 'hourly-temp', `${hour.temperature ?? '--'}${DEGREE_SYMBOL}${hour.temperatureUnit || 'F'}`));
    card.appendChild(createElement('p', 'hourly-brief', hour.shortForecast || 'Forecast unavailable'));
    const precipText = hour.precipitationChance === null || hour.precipitationChance === undefined
      ? 'Precip: n/a'
      : `Precip: ${hour.precipitationChance}%`;
    card.appendChild(createElement('p', 'hourly-brief', precipText));
    forecastDom.hourlyList.appendChild(card);
  }
}

function renderDaily(data) {
  if (!forecastDom.dailyList) return;
  forecastDom.dailyList.innerHTML = '';
  const days = Array.isArray(data.daily) ? data.daily : [];
  if (days.length === 0) {
    forecastDom.dailyList.appendChild(createElement('p', 'forecast-summary', '7-day forecast is unavailable.'));
    return;
  }

  for (const day of days) {
    const card = createElement('div', 'daily-card');
    card.appendChild(createElement('p', 'daily-name', day.name || 'Day'));
    card.appendChild(createElement('p', 'daily-temp', `${day.temperature ?? '--'}${DEGREE_SYMBOL}${day.temperatureUnit || 'F'}`));
    card.appendChild(createElement('p', 'daily-brief', day.shortForecast || 'Forecast unavailable'));
    forecastDom.dailyList.appendChild(card);
  }
}

async function loadForecast(zip) {
  if (!forecastDom.status || !forecastDom.submitBtn || !forecastDom.results) return;
  const cleanedZip = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(cleanedZip)) {
    setForecastError('Please enter a valid 5-digit ZIP code.');
    forecastDom.results.hidden = true;
    return;
  }

  forecastRequestId += 1;
  const requestId = forecastRequestId;
  clearForecastError();
  forecastDom.status.textContent = `Loading forecast for ${cleanedZip}...`;
  forecastDom.submitBtn.disabled = true;
  forecastDom.submitBtn.textContent = 'Loading...';

  try {
    const response = await fetch(`/api/forecast?zip=${encodeURIComponent(cleanedZip)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (requestId !== forecastRequestId) return;
    if (!response.ok) {
      throw new Error(payload?.error || `Forecast request failed (${response.status})`);
    }

    try {
      localStorage.setItem(FORECAST_STORAGE_KEY, cleanedZip);
    } catch {
      // Ignore storage failures.
    }

    renderCurrentSummary(payload);
    renderTodaySummary(payload);
    renderRadar(payload);
    renderHourly(payload);
    renderDaily(payload);
    forecastDom.results.hidden = false;

    const place = payload?.location?.city && payload?.location?.state
      ? `${payload.location.city}, ${payload.location.state}`
      : cleanedZip;
    forecastDom.status.textContent = `Showing forecast for ${place}. Last updated ${formatDateTime(payload.updatedAt)}.`;
  } catch (err) {
    if (requestId !== forecastRequestId) return;
    forecastDom.results.hidden = true;
    setForecastError(getErrorMessage(err));
  } finally {
    if (requestId === forecastRequestId) {
      forecastDom.submitBtn.disabled = false;
      forecastDom.submitBtn.textContent = 'Get forecast';
    }
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));

  tab.addEventListener('keydown', (event) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;

    if (nextIndex !== index) {
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      activateTab(nextTab);
      nextTab.focus();
    }
  });
});

let persistedZip = '';
try {
  persistedZip = String(localStorage.getItem(FORECAST_STORAGE_KEY) || '');
} catch {
  persistedZip = '';
}

const requestedTab = new URLSearchParams(window.location.search).get('tab');
const defaultTab = tabs.find((tab) => tab.classList.contains('is-active')) || tabs[0];
const forecastTab = tabs.find((tab) => tab.dataset.panel === 'forecast');
const requestedTabMatch = tabs.find((tab) => tab.dataset.panel === requestedTab);
const autoForecastTab = !requestedTab && /^\d{5}$/.test(persistedZip) ? forecastTab : null;
const initialTab = requestedTabMatch || autoForecastTab || defaultTab;
if (initialTab) activateTab(initialTab, { updateUrl: false });

if (forecastDom.form && forecastDom.zipInput) {
  forecastDom.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadForecast(forecastDom.zipInput.value);
  });

  forecastDom.zipInput.addEventListener('input', () => {
    forecastDom.zipInput.value = forecastDom.zipInput.value.replace(/\D/g, '').slice(0, 5);
  });

  if (/^\d{5}$/.test(persistedZip)) {
    forecastDom.zipInput.value = persistedZip;
    loadForecast(persistedZip);
  }
}
