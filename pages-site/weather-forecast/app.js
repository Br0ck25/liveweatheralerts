const DEGREE_SYMBOL = '\u00B0';
const ZIP_STORAGE_KEY = 'lwa_saved_zip';
const LAT_STORAGE_KEY = 'lwa_saved_lat';
const LON_STORAGE_KEY = 'lwa_saved_lon';
const MODE_STORAGE_KEY = 'lwa_saved_mode';

const dom = {
  zipForm: document.getElementById('zipForm'),
  zipInput: document.getElementById('zipInput'),
  zipSubmit: document.getElementById('zipSubmit'),
  useLocationBtn: document.getElementById('useLocationBtn'),
  statusText: document.getElementById('statusText'),
  errorText: document.getElementById('errorText'),
  conditionLine: document.getElementById('conditionLine'),
  conditionText: document.getElementById('conditionText'),
  currentIconGlyph: document.getElementById('currentIconGlyph'),
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

function parseCoordinate(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
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

function formatDayShort(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'day';
  return date.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
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

function getPrecipLabel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  return `${Math.round(Number(value))}%`;
}

function isNightForecast(forecastText, startTime) {
  const lower = String(forecastText || '').toLowerCase();
  if (lower.includes('night') || lower.includes('overnight')) return true;

  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) return false;
  const hour = date.getHours();
  return hour < 6 || hour >= 19;
}

function getWeatherEmoji(forecastText, options = {}) {
  const text = String(forecastText || '').toLowerCase();
  const night = Boolean(options.night);

  if (text.includes('thunder') || text.includes('t-storm')) return '⛈️';
  if (text.includes('snow') || text.includes('flurr') || text.includes('sleet') || text.includes('ice')) return '🌨️';
  if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return '🌧️';
  if (text.includes('fog') || text.includes('mist') || text.includes('haze') || text.includes('smoke')) return '🌫️';
  if (text.includes('wind')) return '💨';
  if (text.includes('cloud') || text.includes('overcast')) return '☁️';
  if (text.includes('partly') || text.includes('mostly clear')) return night ? '🌙' : '⛅';
  if (text.includes('clear') || text.includes('sunny') || text.includes('fair')) return night ? '🌙' : '☀️';
  return night ? '🌙' : '⛅';
}

function createIconBadge(forecastText, startTime, className) {
  const icon = document.createElement('span');
  icon.className = className;
  icon.setAttribute('aria-label', forecastText || 'Weather icon');
  icon.title = forecastText || 'Weather icon';
  icon.textContent = getWeatherEmoji(forecastText, {
    night: isNightForecast(forecastText, startTime),
  });
  return icon;
}

function renderCurrent(payload) {
  const current = payload.current || {};
  const today = payload.today || {};
  const city = payload?.location?.city || 'Your area';
  const state = payload?.location?.state || '';

  if (dom.conditionText) {
    dom.conditionText.textContent = current.condition || `${city}${state ? `, ${state}` : ''}`;
  }

  if (dom.currentIconGlyph) {
    dom.currentIconGlyph.textContent = getWeatherEmoji(current.condition, {
      night: isNightForecast(current.condition, new Date().toISOString()),
    });
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

    item.appendChild(createIconBadge(hour.shortForecast || '', hour.startTime, 'hourly-icon'));

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

    item.appendChild(createIconBadge(day.shortForecast || '', day.startTime, 'daily-icon'));

    const precip = document.createElement('p');
    precip.className = 'daily-precip';
    precip.textContent = getPrecipLabel(day.precipitationChance);
    item.appendChild(precip);

    const name = document.createElement('p');
    name.className = 'daily-name';
    name.textContent = formatDayShort(day.startTime);
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
  const fallbackStaticMapUrl = buildStaticMapUrl(latitude, longitude);
  const radarLoopUrl = payload?.map?.radarLoopUrl || '';
  const mapClickUrl = payload?.map?.mapClickUrl || 'https://forecast.weather.gov/';
  const radarPageUrl = payload?.map?.radarPageUrl || 'https://radar.weather.gov/';

  dom.mapLink.href = mapClickUrl;
  dom.radarLink.href = radarPageUrl;

  const candidates = [radarLoopUrl, fallbackStaticMapUrl].filter(Boolean);
  if (candidates.length === 0) {
    dom.mapImage.hidden = true;
    dom.mapImage.removeAttribute('src');
    dom.mapFallback.hidden = false;
    dom.mapFallback.textContent = 'Map preview is unavailable for this location right now.';
    return;
  }

  let candidateIndex = 0;
  const tryNext = () => {
    if (candidateIndex >= candidates.length) {
      dom.mapImage.hidden = true;
      dom.mapImage.removeAttribute('src');
      dom.mapFallback.hidden = false;
      dom.mapFallback.textContent = 'Map preview did not load. Use the map links below.';
      return;
    }

    const src = candidates[candidateIndex];
    candidateIndex += 1;
    dom.mapImage.src = src;
    dom.mapImage.hidden = false;
    dom.mapFallback.hidden = true;
  };

  dom.mapImage.onerror = () => {
    tryNext();
  };

  tryNext();
}

function wireScrollerButtons() {
  const buttons = Array.from(document.querySelectorAll('.scroll-btn'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      const direction = Number(button.getAttribute('data-direction') || 1);
      const list = targetId ? document.getElementById(targetId) : null;
      if (!list) return;

      const moveBy = Math.max(144, Math.round(list.clientWidth * 0.7));
      list.scrollBy({
        left: direction * moveBy,
        behavior: 'smooth',
      });
    });
  }
}

async function loadForecast(requestInput) {
  if (!dom.statusText || !dom.zipSubmit || !dom.useLocationBtn) return;

  let query = '';
  let saveMode = 'zip';

  if (requestInput?.mode === 'latlon') {
    const lat = parseCoordinate(requestInput.lat);
    const lon = parseCoordinate(requestInput.lon);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setError('Enter valid latitude and longitude values.');
      return;
    }

    query = `lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    saveMode = 'latlon';
  } else {
    const cleanedZip = cleanZip(requestInput?.zip || '');
    if (!/^\d{5}$/.test(cleanedZip)) {
      setError('Please enter a valid 5-digit ZIP code.');
      return;
    }

    query = `zip=${encodeURIComponent(cleanedZip)}`;
    saveMode = 'zip';
  }

  activeRequestId += 1;
  const requestId = activeRequestId;
  clearError();
  dom.statusText.textContent = 'Loading forecast...';
  dom.zipSubmit.disabled = true;
  dom.useLocationBtn.disabled = true;
  dom.zipSubmit.textContent = 'Loading...';

  try {
    const response = await fetch(`/api/forecast?${query}`, {
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
      localStorage.setItem(MODE_STORAGE_KEY, saveMode);
      if (saveMode === 'zip') {
        const cleanedZip = cleanZip(requestInput?.zip || '');
        localStorage.setItem(ZIP_STORAGE_KEY, cleanedZip);
      } else {
        localStorage.setItem(LAT_STORAGE_KEY, String(requestInput.lat));
        localStorage.setItem(LON_STORAGE_KEY, String(requestInput.lon));
      }
    } catch {
      // Ignore storage failures.
    }

    renderCurrent(payload);
    renderHourly(payload);
    renderDaily(payload);
    renderMap(payload);

    const city = payload?.location?.city || 'Selected location';
    const state = payload?.location?.state ? `, ${payload.location.state}` : '';
    dom.statusText.textContent = `Forecast for ${city}${state}. Updated ${formatUpdatedAt(payload.updatedAt)}.`;
  } catch (error) {
    if (requestId !== activeRequestId) return;
    setError(getErrorMessage(error));
  } finally {
    if (requestId === activeRequestId) {
      dom.zipSubmit.disabled = false;
      dom.useLocationBtn.disabled = false;
      dom.zipSubmit.textContent = 'Update';
    }
  }
}

function useBrowserLocation() {
  if (!navigator.geolocation) {
    setError('Geolocation is not available on this device/browser.');
    return;
  }

  clearError();
  if (dom.statusText) {
    dom.statusText.textContent = 'Getting your location...';
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      await loadForecast({ mode: 'latlon', lat, lon });
    },
    (error) => {
      if (error.code === 1) {
        setError('Location permission was denied. You can still use ZIP.');
        return;
      }
      setError('Could not get location right now. You can still use ZIP.');
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 300000,
    },
  );
}

if (dom.zipInput) {
  dom.zipInput.addEventListener('input', () => {
    dom.zipInput.value = cleanZip(dom.zipInput.value);
  });
}

if (dom.zipForm && dom.zipInput) {
  dom.zipForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadForecast({ mode: 'zip', zip: dom.zipInput.value });
  });
}

if (dom.useLocationBtn) {
  dom.useLocationBtn.addEventListener('click', () => {
    useBrowserLocation();
  });
}

wireScrollerButtons();

let savedMode = 'zip';
let savedZip = '';
let savedLat = '';
let savedLon = '';

try {
  savedMode = String(localStorage.getItem(MODE_STORAGE_KEY) || 'zip');
  savedZip = String(localStorage.getItem(ZIP_STORAGE_KEY) || '');
  savedLat = String(localStorage.getItem(LAT_STORAGE_KEY) || '');
  savedLon = String(localStorage.getItem(LON_STORAGE_KEY) || '');
} catch {
  savedMode = 'zip';
}

if (savedMode === 'latlon') {
  const lat = parseCoordinate(savedLat);
  const lon = parseCoordinate(savedLon);
  if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    loadForecast({ mode: 'latlon', lat, lon });
  } else if (/^\d{5}$/.test(savedZip) && dom.zipInput) {
    dom.zipInput.value = savedZip;
    loadForecast({ mode: 'zip', zip: savedZip });
  }
} else if (/^\d{5}$/.test(savedZip) && dom.zipInput) {
  dom.zipInput.value = savedZip;
  loadForecast({ mode: 'zip', zip: savedZip });
}
