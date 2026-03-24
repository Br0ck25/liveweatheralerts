const DEFAULT_WORKER_ORIGIN = 'https://live-weather.jamesbrock25.workers.dev';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet(context) {
  const workerOrigin = String(context.env.WEATHER_WORKER_ORIGIN || DEFAULT_WORKER_ORIGIN).replace(/\/+$/, '');
  const upstreamUrl = `${workerOrigin}/api/push/public-key`;
  let upstream;

  try {
    upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Unable to reach weather backend',
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

  const headers = new Headers(upstream.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  headers.set('Cache-Control', 'no-store');
  if (!headers.get('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
