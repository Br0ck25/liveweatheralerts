const DEGREE_SYMBOL = '\u00B0';
const ZIP_STORAGE_KEY = 'lwa_saved_zip';

const dom = {
  zipForm: document.getElementById('zipForm'),
  zipInput: document.getElementById('zipInput'),
  zipSubmit: document.getElementById('zipSubmit'),
  statusText: document.getElementById('statusText'),
  errorText: document.getElementById('errorText'),
  conditionLine: document.getElementById('conditionLine'),
  conditionText: document.getElementById('conditionText'),
  currentIcon: document.getElementById('currentIcon'),
  currentTemp: document.getElementById('currentTemp'),
  feelsLikeText: document.getElementById('feelsLikeText'),
  highLowText: document.getElementById('highLowText'),
  hourlyList: document.getElementById('hourlyList'),
  dailyList: document.getElementById('dailyList'),
  mapImage: document.getElementById('mapImage'),
  mapFallback: document.getElementById('mapFallback'),
  mapLink: document.getElementById('mapLink'),
  radarLink: document.getElementById('radarLink'),
};

let activeRequestId = 0;

function cleanZip(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 5);
}

function getErrorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message || 'Forecast unavailable right now.');
  }
  return String(error || 'Forecast unavailable right now.');
}

function formatHourLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time n/a';
  return date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).replace(':00', '');
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
  });
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown update time';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function setError(message) {
  if (!dom.errorText || !dom.statusText) return;
  dom.errorText.hidden = false;
  dom.errorText.textContent = message;
  dom.statusText.textContent = 'Forecast unavailable right now.';
}

function clearError() {
  if (!dom.errorText) return;
  dom.errorText.hidden = true;
  dom.errorText.textContent = '';
}

function createIcon(url, className, altText) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = altText;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  if (url) {
    img.src = url;
  } else {
    img.hidden = true;
  }
  return img;
}

function getPrecipLabel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  return `${Math.round(Number(value))}%`;
}

function renderCurrent(payload) {
  const current = payload.current || {};
  const today = payload.today || {};
  const city = payload?.location?.city || 'Your area';
  const state = payload?.location?.state || '';

  if (dom.conditionText) {
    dom.conditionText.textContent = current.condition || `${city}${state ? `, ${state}` : ''}`;
  }

  if (dom.currentIcon) {
    if (current.icon) {
      dom.currentIcon.src = current.icon;
      dom.currentIcon.hidden = false;
    } else {
      dom.currentIcon.removeAttribute('src');
      dom.currentIcon.hidden = true;
    }
  }

  if (dom.conditionLine) {
    dom.conditionLine.hidden = false;
  }

  const tempValue = current.temperature ?? '--';
  if (dom.currentTemp) {
    dom.currentTemp.textContent = `${tempValue}${DEGREE_SYMBOL}`;
  }

  if (dom.feelsLikeText) {
    const feels = current.feelsLike ?? '--';
    const feelsUnit = current.feelsLikeUnit || 'F';
    dom.feelsLikeText.textContent = `Feels like ${feels}${DEGREE_SYMBOL}${feelsUnit}`;
  }

  if (dom.highLowText) {
    const high = today.high ?? '--';
    const low = today.low ?? '--';
    dom.highLowText.textContent = `High ${high}${DEGREE_SYMBOL}  -  Low ${low}${DEGREE_SYMBOL}`;
  }
}

function renderHourly(payload) {
  if (!dom.hourlyList) return;
  dom.hourlyList.innerHTML = '';
  const hours = Array.isArray(payload.hourly) ? payload.hourly.slice(0, 16) : [];

  if (hours.length === 0) {
    const fallback = document.createElement('p');
    fallback.className = 'map-fallback';
    fallback.textContent = 'Hourly forecast is not available right now.';
    dom.hourlyList.appendChild(fallback);
    return;
  }

  for (const hour of hours) {
    const item = document.createElement('article');
    item.className = 'hourly-item';

    const temp = document.createElement('p');
    temp.className = 'hourly-temp';
    temp.textContent = `${hour.temperature ?? '--'}${DEGREE_SYMBOL}`;
    item.appendChild(temp);

    item.appendChild(createIcon(hour.icon || '', 'hourly-icon', hour.shortForecast || 'Hourly forecast icon'));

    const precip = document.createElement('p');
    precip.className = 'hourly-precip';
    precip.textContent = getPrecipLabel(hour.precipitationChance);
    item.appendChild(precip);

    const time = document.createElement('p');
    time.className = 'hourly-time';
    time.textContent = formatHourLabel(hour.startTime);
    item.appendChild(time);

    dom.hourlyList.appendChild(item);
  }
}

function renderDaily(payload) {
  if (!dom.dailyList) return;
  dom.dailyList.innerHTML = '';
  const days = Array.isArray(payload.daily) ? payload.daily.slice(0, 7) : [];

  if (days.length === 0) {
    const fallback = document.createElement('p');
    fallback.className = 'map-fallback';
    fallback.textContent = 'Daily forecast is not available right now.';
    dom.dailyList.appendChild(fallback);
    return;
  }

  for (const day of days) {
    const item = document.createElement('article');
    item.className = 'daily-item';

    const high = document.createElement('p');
    high.className = 'daily-high';
    high.textContent = `${day.temperature ?? '--'}${DEGREE_SYMBOL}`;
    item.appendChild(high);

    const low = document.createElement('p');
    low.className = 'daily-low';
    low.textContent = `${day.lowTemperature ?? '--'}${DEGREE_SYMBOL}`;
    item.appendChild(low);

    item.appendChild(createIcon(day.icon || '', 'daily-icon', day.shortForecast || 'Daily forecast icon'));

    const precip = document.createElement('p');
    precip.className = 'daily-precip';
    precip.textContent = getPrecipLabel(day.precipitationChance);
    item.appendChild(precip);

    const name = document.createElement('p');
    name.className = 'daily-name';
    name.textContent = day.name || 'Day';
    item.appendChild(name);

    const date = document.createElement('p');
    date.className = 'daily-date';
    date.textContent = formatShortDate(day.startTime);
    item.appendChild(date);

    dom.dailyList.appendChild(item);
  }
}

function buildStaticMapUrl(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';

  const latValue = latitude.toFixed(4);
  const lonValue = longitude.toFixed(4);
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${latValue},${lonValue}&zoom=8&size=900x420&markers=${latValue},${lonValue},red-pushpin`;
}

function renderMap(payload) {
  if (!dom.mapImage || !dom.mapFallback || !dom.mapLink || !dom.radarLink) return;

  const latitude = payload?.location?.latitude;
  const longitude = payload?.location?.longitude;
  const staticMapUrl = buildStaticMapUrl(latitude, longitude);
  const mapClickUrl = payload?.map?.mapClickUrl || 'https://forecast.weather.gov/';
  const radarPageUrl = payload?.map?.radarPageUrl || 'https://radar.weather.gov/';

  dom.mapLink.href = mapClickUrl;
  dom.radarLink.href = radarPageUrl;

  if (!staticMapUrl) {
    dom.mapImage.hidden = true;
    dom.mapImage.removeAttribute('src');
    dom.mapFallback.hidden = false;
    dom.mapFallback.textContent = 'Map preview is unavailable for this location right now.';
    return;
  }

  dom.mapImage.onerror = () => {
    dom.mapImage.hidden = true;
    dom.mapFallback.hidden = false;
    dom.mapFallback.textContent = 'Map preview did not load. Use the map link below.';
  };

  dom.mapImage.src = staticMapUrl;
  dom.mapImage.hidden = false;
  dom.mapFallback.hidden = true;
}

function wireScrollerButtons() {
  const buttons = Array.from(document.querySelectorAll('.scroll-btn'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      const direction = Number(button.getAttribute('data-direction') || 1);
      const list = targetId ? document.getElementById(targetId) : null;
      if (!list) return;

      const moveBy = Math.max(180, Math.round(list.clientWidth * 0.75));
      list.scrollBy({
        left: direction * moveBy,
        behavior: 'smooth',
      });
    });
  }
}

async function loadForecast(zip) {
  if (!dom.statusText || !dom.zipSubmit) return;
  const cleanedZip = cleanZip(zip);

  if (!/^\d{5}$/.test(cleanedZip)) {
    setError('Please enter a valid 5-digit ZIP code.');
    return;
  }

  activeRequestId += 1;
  const requestId = activeRequestId;
  clearError();
  dom.statusText.textContent = `Loading forecast for ${cleanedZip}...`;
  dom.zipSubmit.disabled = true;
  dom.zipSubmit.textContent = 'Loading...';

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

    if (requestId !== activeRequestId) return;
    if (!response.ok || !payload) {
      throw new Error(payload?.error || `Forecast request failed (${response.status})`);
    }

    try {
      localStorage.setItem(ZIP_STORAGE_KEY, cleanedZip);
    } catch {
      // Ignore storage failures.
    }

    renderCurrent(payload);
    renderHourly(payload);
    renderDaily(payload);
    renderMap(payload);

    const city = payload?.location?.city || cleanedZip;
    const state = payload?.location?.state ? `, ${payload.location.state}` : '';
    dom.statusText.textContent = `Forecast for ${city}${state}. Updated ${formatUpdatedAt(payload.updatedAt)}.`;
  } catch (error) {
    if (requestId !== activeRequestId) return;
    setError(getErrorMessage(error));
  } finally {
    if (requestId === activeRequestId) {
      dom.zipSubmit.disabled = false;
      dom.zipSubmit.textContent = 'Update';
    }
  }
}

if (dom.zipInput) {
  dom.zipInput.addEventListener('input', () => {
    dom.zipInput.value = cleanZip(dom.zipInput.value);
  });
}

if (dom.zipForm && dom.zipInput) {
  dom.zipForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadForecast(dom.zipInput.value);
  });
}

wireScrollerButtons();

let savedZip = '';
try {
  savedZip = String(localStorage.getItem(ZIP_STORAGE_KEY) || '');
} catch {
  savedZip = '';
}

if (/^\d{5}$/.test(savedZip) && dom.zipInput) {
  dom.zipInput.value = savedZip;
  loadForecast(savedZip);
}

