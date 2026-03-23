const ZIP_LOOKUP_BASE = 'https://api.zippopotam.us/us/';
const NWS_BASE = 'https://api.weather.gov';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function cToF(celsius) {
  if (celsius === null || celsius === undefined || Number.isNaN(Number(celsius))) return null;
  return Math.round((Number(celsius) * 9) / 5 + 32);
}

function mpsToMph(mps) {
  if (mps === null || mps === undefined || Number.isNaN(Number(mps))) return null;
  return Math.round(Number(mps) * 2.23694);
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function degToCardinal(deg) {
  const d = asNumber(deg);
  if (d === null) return null;
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round((((d % 360) + 360) % 360) / 22.5) % 16;
  return directions[index];
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function formatWind(directionDeg, speedMps) {
  const mph = mpsToMph(speedMps);
  const dir = degToCardinal(directionDeg);
  if (mph === null && !dir) return 'Not available';
  if (mph === null) return `${dir}`;
  if (!dir) return `${mph} mph`;
  return `${dir} ${mph} mph`;
}

function normalizeHourlyPeriod(period) {
  const precip = asNumber(period?.probabilityOfPrecipitation?.value);
  return {
    startTime: period?.startTime || null,
    temperature: asNumber(period?.temperature),
    temperatureUnit: safeText(period?.temperatureUnit, 'F'),
    shortForecast: safeText(period?.shortForecast, 'No forecast text'),
    icon: safeText(period?.icon, ''),
    precipitationChance: precip,
    windSpeed: safeText(period?.windSpeed, ''),
    windDirection: safeText(period?.windDirection, ''),
  };
}

function normalizeDailyPeriod(period) {
  const precip = asNumber(period?.probabilityOfPrecipitation?.value);
  return {
    name: safeText(period?.name, 'Forecast'),
    startTime: period?.startTime || null,
    isDaytime: Boolean(period?.isDaytime),
    temperature: asNumber(period?.temperature),
    temperatureUnit: safeText(period?.temperatureUnit, 'F'),
    shortForecast: safeText(period?.shortForecast, 'No forecast text'),
    detailedForecast: safeText(period?.detailedForecast, ''),
    icon: safeText(period?.icon, ''),
    precipitationChance: precip,
  };
}

function buildDailySummaries(periods) {
  const summaries = [];
  for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i];
    if (!period?.isDaytime) continue;

    const nextPeriod = periods[i + 1];
    const overnight = nextPeriod && !nextPeriod.isDaytime ? nextPeriod : null;
    const daytimePrecip = asNumber(period.precipitationChance);
    const overnightPrecip = asNumber(overnight?.precipitationChance);

    summaries.push({
      ...period,
      lowTemperature: asNumber(overnight?.temperature),
      lowTemperatureUnit: safeText(overnight?.temperatureUnit, period.temperatureUnit || 'F'),
      overnightForecast: safeText(overnight?.shortForecast, ''),
      precipitationChance: daytimePrecip ?? overnightPrecip,
    });
  }
  return summaries;
}

function getHighLowFromPeriods(periods, hourly) {
  let high = null;
  let low = null;

  for (const period of periods.slice(0, 6)) {
    const temp = asNumber(period?.temperature);
    if (temp === null) continue;
    if (period?.isDaytime && high === null) high = temp;
    if (!period?.isDaytime && low === null) low = temp;
    if (high !== null && low !== null) break;
  }

  if ((high === null || low === null) && Array.isArray(hourly) && hourly.length > 0) {
    const values = hourly
      .slice(0, 24)
      .map((item) => asNumber(item.temperature))
      .filter((item) => item !== null);
    if (values.length > 0) {
      if (high === null) high = Math.max(...values);
      if (low === null) low = Math.min(...values);
    }
  }

  return { high, low };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/geo+json, application/json',
      'User-Agent': 'LiveWeatherAlerts/1.0 (liveweatheralerts.com)',
    },
    cf: {
      cacheTtl: 300,
      cacheEverything: true,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return await response.json();
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const zipParam = String(requestUrl.searchParams.get('zip') || '').trim();
  const latRaw = requestUrl.searchParams.get('lat');
  const lonRaw = requestUrl.searchParams.get('lon');
  const latParam = latRaw === null || latRaw.trim() === '' ? null : asNumber(latRaw);
  const lonParam = lonRaw === null || lonRaw.trim() === '' ? null : asNumber(lonRaw);

  const hasLatLon = latParam !== null && lonParam !== null;
  const latLonInRange = hasLatLon && latParam >= -90 && latParam <= 90 && lonParam >= -180 && lonParam <= 180;
  const hasZip = /^\d{5}$/.test(zipParam);

  let zip = null;
  let firstPlace = null;
  let latitude = null;
  let longitude = null;
  let queryMode = '';

  if (latLonInRange) {
    latitude = latParam;
    longitude = lonParam;
    queryMode = 'latlon';
  } else if (hasZip) {
    let zipData;
    try {
      zipData = await fetchJson(`${ZIP_LOOKUP_BASE}${zipParam}`);
    } catch {
      return new Response(JSON.stringify({
        error: 'Unable to find that ZIP code.',
      }), {
        status: 404,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    firstPlace = Array.isArray(zipData?.places) ? zipData.places[0] : null;
    latitude = asNumber(firstPlace?.latitude);
    longitude = asNumber(firstPlace?.longitude);
    if (latitude === null || longitude === null) {
      return new Response(JSON.stringify({
        error: 'ZIP found, but location coordinates were unavailable.',
      }), {
        status: 502,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    zip = zipParam;
    queryMode = 'zip';
  } else {
    return new Response(JSON.stringify({
      error: 'Provide either a valid 5-digit ZIP code or valid latitude/longitude coordinates.',
    }), {
      status: 400,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    const points = await fetchJson(`${NWS_BASE}/points/${latitude},${longitude}`);
    const props = points?.properties || {};

    const [dailyForecastData, hourlyForecastData, stationsData] = await Promise.all([
      fetchJson(String(props.forecast || '')),
      fetchJson(String(props.forecastHourly || '')),
      fetchJson(String(props.observationStations || '')),
    ]);

    const dailyPeriods = Array.isArray(dailyForecastData?.properties?.periods)
      ? dailyForecastData.properties.periods.map(normalizeDailyPeriod)
      : [];
    const hourlyPeriods = Array.isArray(hourlyForecastData?.properties?.periods)
      ? hourlyForecastData.properties.periods.map(normalizeHourlyPeriod)
      : [];

    const stationFeature = Array.isArray(stationsData?.features) ? stationsData.features[0] : null;
    const stationUrl = safeText(stationFeature?.id, '');

    let observation = null;
    if (stationUrl) {
      try {
        const latestObs = await fetchJson(`${stationUrl}/observations/latest`);
        observation = latestObs?.properties || null;
      } catch {
        observation = null;
      }
    }

    const currentTempC = asNumber(observation?.temperature?.value);
    const windChillC = asNumber(observation?.windChill?.value);
    const heatIndexC = asNumber(observation?.heatIndex?.value);
    const currentTempF = cToF(currentTempC);
    const feelsLikeC = heatIndexC ?? windChillC ?? currentTempC;
    const feelsLikeF = cToF(feelsLikeC);

    const firstHourly = hourlyPeriods[0] || null;
    const fallbackTemp = firstHourly ? asNumber(firstHourly.temperature) : null;
    const fallbackUnit = firstHourly ? safeText(firstHourly.temperatureUnit, 'F') : 'F';
    const currentTempValue = currentTempF ?? fallbackTemp;
    const currentTempUnit = currentTempF !== null ? 'F' : fallbackUnit;
    let feelsLikeSource = 'temperature';
    if (heatIndexC !== null) {
      feelsLikeSource = 'heatIndex';
    } else if (windChillC !== null) {
      feelsLikeSource = 'windChill';
    } else if (currentTempC !== null) {
      feelsLikeSource = 'temperature';
    } else if (fallbackTemp !== null) {
      feelsLikeSource = 'hourlyTemperature';
    }

    const { high, low } = getHighLowFromPeriods(dailyPeriods, hourlyPeriods);

    const radarStation = safeText(props.radarStation, '');
    const radarLoopUrl = radarStation ? `https://radar.weather.gov/ridge/standard/${radarStation}_loop.gif` : null;
    const radarPageUrl = radarStation ? `https://radar.weather.gov/station/${radarStation}/standard` : 'https://radar.weather.gov/';

    const payload = {
      zip,
      updatedAt: new Date().toISOString(),
      location: {
        city: safeText(firstPlace?.['place name'], safeText(props?.relativeLocation?.properties?.city, 'Unknown')),
        state: safeText(firstPlace?.state, safeText(props?.relativeLocation?.properties?.state, '')),
        latitude,
        longitude,
        timeZone: safeText(props?.timeZone, ''),
      },
      current: {
        temperature: currentTempValue,
        temperatureUnit: currentTempUnit,
        feelsLike: feelsLikeF ?? currentTempValue,
        feelsLikeUnit: 'F',
        feelsLikeSource,
        condition: safeText(observation?.textDescription, safeText(dailyPeriods[0]?.shortForecast, 'Not available')),
        humidity: asNumber(observation?.relativeHumidity?.value),
        wind: formatWind(observation?.windDirection?.value, observation?.windSpeed?.value),
        icon: safeText(dailyPeriods[0]?.icon, ''),
      },
      today: {
        high,
        low,
        unit: 'F',
      },
      hourly: hourlyPeriods.slice(0, 24),
      daily: buildDailySummaries(dailyPeriods).slice(0, 7),
      map: {
        radarStation: radarStation || null,
        radarLoopUrl,
        radarPageUrl,
        mapClickUrl: `https://forecast.weather.gov/MapClick.php?lat=${latitude}&lon=${longitude}`,
      },
      source: {
        queryMode,
        zipProvided: zip,
        coordinatesUsed: { latitude, longitude },
        zipLookup: zip ? `${ZIP_LOOKUP_BASE}${zip}` : null,
        points: `${NWS_BASE}/points/${latitude},${longitude}`,
        forecast: safeText(props.forecast, ''),
        forecastHourly: safeText(props.forecastHourly, ''),
        observationStations: safeText(props.observationStations, ''),
        nearestStation: stationUrl,
        feelsLikeObservation: stationUrl ? `${stationUrl}/observations/latest` : null,
        feelsLikeField: (
          feelsLikeSource === 'heatIndex'
            ? 'properties.heatIndex.value'
            : feelsLikeSource === 'windChill'
              ? 'properties.windChill.value'
              : feelsLikeSource === 'temperature'
                ? 'properties.temperature.value'
                : 'hourly.periods[0].temperature'
        ),
      },
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Unable to load forecast data right now.',
      detail: String(err),
    }), {
      status: 502,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
