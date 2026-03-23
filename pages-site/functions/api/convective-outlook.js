const DAY_OUTLOOK_SOURCES = [
  { day: 1, url: 'https://www.spc.noaa.gov/products/outlook/day1otlk.html' },
  { day: 2, url: 'https://www.spc.noaa.gov/products/outlook/day2otlk.html' },
  { day: 3, url: 'https://www.spc.noaa.gov/products/outlook/day3otlk.html' },
];

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
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(text) {
  return normalizeText(
    decodeHtmlEntities(
      String(text || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|pre)>/gi, '\n')
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]{2,}/g, ' '),
    ),
  );
}

function extractTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractCanonicalLink(html, fallbackUrl) {
  const match = String(html || '').match(/<meta\s+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  const raw = (match ? match[1] : '').trim();
  if (!raw) return fallbackUrl;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `https://www.spc.noaa.gov${raw}`;
  return raw;
}

function extractPreText(html, day) {
  const blocks = Array.from(String(html || '').matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi))
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);

  const target = blocks.find((text) => {
    const lower = text.toLowerCase();
    return lower.includes(`day ${day} convective outlook`) && lower.includes('spc ac');
  });
  if (target) return target;

  const fallback = blocks.find((text) => {
    const lower = text.toLowerCase();
    return lower.includes('spc ac') && lower.includes('summary');
  });
  return fallback || '';
}

function titleFromPreText(preText, day, pageTitle) {
  const preMatch = String(preText || '').match(/Day\s+\d+\s+(?:Convective|Severe Thunderstorm)\s+Outlook/i);
  if (preMatch) return preMatch[0];
  const titleMatch = String(pageTitle || '').match(/Day\s+\d+\s+(?:Convective|Severe Thunderstorm)\s+Outlook/i);
  if (titleMatch) return titleMatch[0];
  return `Day ${day} Convective Outlook`;
}

function collapseForCard(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractSummary(preText) {
  const text = String(preText || '');
  const summaryMatch = text.match(/\.{3}SUMMARY\.{3}\s*([\s\S]*?)(?:\n\s*\.{3}[^\n]+\.{3}|\n\s*\.\.[^\n]+\.\.|$)/i);
  if (summaryMatch && summaryMatch[1]) {
    const collapsed = collapseForCard(summaryMatch[1]);
    if (collapsed) return collapsed;
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summaryLineIndex = lines.findIndex((line) => /summary/i.test(line));
  if (summaryLineIndex >= 0) {
    const fallback = collapseForCard(lines.slice(summaryLineIndex + 1, summaryLineIndex + 4).join(' '));
    if (fallback) return fallback;
  }
  return '';
}

function extractPublishedLine(preText) {
  const lines = String(preText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const explicit = lines.find((line) => /\b(?:AM|PM)\b\s+[A-Z]{2,4}\s+(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{4}\b/i.test(line));
  if (explicit) return explicit;

  const nwsIndex = lines.findIndex((line) => /NWS Storm Prediction Center/i.test(line));
  if (nwsIndex >= 0 && lines[nwsIndex + 1]) return lines[nwsIndex + 1];

  return '';
}

function parseSpcDateLine(line) {
  const match = String(line || '').match(/^(\d{3,4})\s+(AM|PM)\s+([A-Z]{2,4})\s+([A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (!match) return null;

  const [, hhmmRaw, amPm, tzRaw, _dow, monthRaw, dayRaw, yearRaw] = match;
  const hhmm = String(hhmmRaw);
  let hour = hhmm.length === 3 ? Number(hhmm.slice(0, 1)) : Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(-2));
  if (amPm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (amPm.toUpperCase() === 'AM' && hour === 12) hour = 0;

  const monthMap = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };
  const timezoneOffsetMap = {
    EST: -5,
    EDT: -4,
    CST: -6,
    CDT: -5,
    MST: -7,
    MDT: -6,
    PST: -8,
    PDT: -7,
  };

  const month = monthMap[monthRaw];
  const tzOffset = timezoneOffsetMap[tzRaw];
  if (month === undefined || tzOffset === undefined || Number.isNaN(minute) || Number.isNaN(hour)) {
    return null;
  }

  const utcMs = Date.UTC(Number(yearRaw), month, Number(dayRaw), hour - tzOffset, minute);
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function detectRisk(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('high risk')) return 'high';
  if (value.includes('moderate risk')) return 'moderate';
  if (value.includes('enhanced risk')) return 'enhanced';
  if (value.includes('slight risk')) return 'slight';
  if (value.includes('marginal risk')) return 'marginal';
  if (value.includes('no severe thunderstorm areas forecast')) return 'none';
  if (value.includes('no severe threat')) return 'none';
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

function createFallbackOutlook(day, url, reason) {
  const risk = 'unknown';
  return {
    day,
    title: `Day ${day} Convective Outlook`,
    link: url,
    publishedAt: null,
    risk,
    riskLabel: riskLabel(risk),
    urgency: urgencyText(risk),
    summary: `Unable to load this SPC outlook right now (${reason}).`,
    loadError: true,
  };
}

function parseDayOutlookHtml(day, url, html) {
  const pageTitle = extractTitle(html);
  const preText = extractPreText(html, day);
  const combined = `${pageTitle}\n${preText}\n${url}`;
  const risk = detectRisk(combined);
  const publishedLine = extractPublishedLine(preText);
  const publishedAt = parseSpcDateLine(publishedLine) || publishedLine || null;
  const summary = extractSummary(preText) || 'Summary text was not available in this outlook.';

  return {
    day,
    title: titleFromPreText(preText, day, pageTitle),
    link: extractCanonicalLink(html, url),
    publishedAt,
    risk,
    riskLabel: riskLabel(risk),
    urgency: urgencyText(risk),
    summary,
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestGet() {
  const outlooks = await Promise.all(DAY_OUTLOOK_SOURCES.map(async ({ day, url }) => {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
        },
        cf: {
          cacheTtl: 60,
          cacheEverything: true,
        },
      });

      if (!response.ok) {
        return createFallbackOutlook(day, url, `HTTP ${response.status}`);
      }

      const html = await response.text();
      return parseDayOutlookHtml(day, url, html);
    } catch (err) {
      return createFallbackOutlook(day, url, String(err));
    }
  }));

  const sortedOutlooks = outlooks.sort((a, b) => a.day - b.day);
  const errorCount = sortedOutlooks.filter((item) => item.loadError).length;
  return new Response(JSON.stringify({
    source: DAY_OUTLOOK_SOURCES.map((item) => item.url),
    updatedAt: new Date().toISOString(),
    outlooks: sortedOutlooks,
    errorCount,
  }), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
