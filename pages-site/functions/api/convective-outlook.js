const SPC_FEED_URL = 'https://www.spc.noaa.gov/products/spcrss.xml';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(text) {
  return decodeHtmlEntities(
    String(text || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function detectRisk(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('high risk')) return 'high';
  if (value.includes('moderate risk')) return 'moderate';
  if (value.includes('enhanced risk')) return 'enhanced';
  if (value.includes('slight risk')) return 'slight';
  if (value.includes('marginal risk')) return 'marginal';
  if (value.includes('no severe thunderstorm areas forecast')) return 'none';
  if (value.includes('general thunderstorm')) return 'general';
  return 'unknown';
}

function riskLabel(risk) {
  if (risk === 'high') return 'High Risk';
  if (risk === 'moderate') return 'Moderate Risk';
  if (risk === 'enhanced') return 'Enhanced Risk';
  if (risk === 'slight') return 'Slight Risk';
  if (risk === 'marginal') return 'Marginal Risk';
  if (risk === 'general') return 'General Storms';
  if (risk === 'none') return 'No Severe Risk';
  return 'Risk Not Clear';
}

function urgencyText(risk) {
  if (risk === 'high') return 'Very dangerous storms are possible. Have a safety plan now.';
  if (risk === 'moderate') return 'Dangerous storms are likely in some places. Be ready to act fast.';
  if (risk === 'enhanced') return 'Strong storms are possible. Stay alert and check updates often.';
  if (risk === 'slight') return 'A few severe storms may happen. Know where to go if warnings are issued.';
  if (risk === 'marginal') return 'A small severe storm chance exists. Keep weather alerts turned on.';
  if (risk === 'general') return 'Regular thunderstorms are possible. Lightning can still be dangerous.';
  if (risk === 'none') return 'No severe storms are expected right now.';
  return 'Storm risk wording is unclear, so keep checking for updates.';
}

function extractSummary(descriptionText) {
  const text = String(descriptionText || '');
  const summaryMatch = text.match(/\.{3}SUMMARY\.{3}\s*([\s\S]*?)(?:\n\s*\.{2,}|$)/i);
  if (summaryMatch) {
    return summaryMatch[1].replace(/\s+/g, ' ').trim();
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => {
    if (/^Day \d+/i.test(line)) return false;
    if (/^NWS Storm Prediction Center/i.test(line)) return false;
    if (/^Valid \d+/i.test(line)) return false;
    if (/^\.\.[A-Za-z].*\.\.$/.test(line)) return false;
    return true;
  });
  return useful.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
}

function parseFeed(xml) {
  const itemMatches = Array.from(String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi));
  const allOutlooks = [];

  for (const match of itemMatches) {
    const block = match[1] || '';
    const title = stripHtml(extractTag(block, 'title'));
    const link = stripHtml(extractTag(block, 'link'));
    const pubDate = stripHtml(extractTag(block, 'pubDate'));
    const descriptionRaw = extractTag(block, 'description');
    const descriptionText = stripHtml(descriptionRaw);

    const combined = `${title}\n${descriptionText}\n${link}`;
    if (!/convective outlook/i.test(combined)) {
      continue;
    }

    const dayMatch = title.match(/Day\s+(\d+)/i) || link.match(/day(\d)otlk/i) || descriptionText.match(/Day\s+(\d+)\s+Convective Outlook/i);
    const day = dayMatch ? Number(dayMatch[1]) : 0;
    const risk = detectRisk(combined);
    const summary = extractSummary(descriptionText) || 'Summary text was not available in the feed.';
    const publishedMs = Number.isNaN(new Date(pubDate).getTime()) ? 0 : new Date(pubDate).getTime();
    const publishedAt = publishedMs > 0 ? new Date(publishedMs).toISOString() : null;

    allOutlooks.push({
      day,
      title,
      link,
      publishedAt: publishedAt || pubDate || null,
      publishedMs,
      risk,
      riskLabel: riskLabel(risk),
      urgency: urgencyText(risk),
      summary,
    });
  }

  allOutlooks.sort((a, b) => b.publishedMs - a.publishedMs);
  const latestByDay = new Map();
  for (const item of allOutlooks) {
    const key = item.day || item.link;
    if (!latestByDay.has(key)) {
      latestByDay.set(key, item);
    }
  }

  return Array.from(latestByDay.values())
    .sort((a, b) => {
      if (a.day && b.day) return a.day - b.day;
      if (a.day) return -1;
      if (b.day) return 1;
      return b.publishedMs - a.publishedMs;
    })
    .map(({ publishedMs, ...rest }) => rest);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet() {
  let xml = '';
  try {
    const response = await fetch(SPC_FEED_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
      },
      cf: {
        cacheTtl: 60,
        cacheEverything: true,
      },
    });

    if (!response.ok) {
      return new Response(JSON.stringify({
        error: 'Unable to load SPC outlook feed',
        status: response.status,
      }), {
        status: 502,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    xml = await response.text();
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Unable to reach SPC outlook feed',
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

  const outlooks = parseFeed(xml);
  return new Response(JSON.stringify({
    source: SPC_FEED_URL,
    updatedAt: new Date().toISOString(),
    outlooks,
  }), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
