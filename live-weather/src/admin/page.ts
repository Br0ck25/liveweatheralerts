import { type Env, type FbAppConfig, type FbAutoPostConfig, type AdminFacebookPostRankBucket, HttpError } from '../types';
import { KV_LAST_POLL, ADMIN_FORECAST_LOCATIONS, ADMIN_CONVECTIVE_OUTLOOKS } from '../constants';
import {
	safeHtml, hailDesc, findProperty, mapSomeValue,
	formatDateTime, formatDateTimeShort, classifyAlert, formatLastSynced, alertToText, severityBadgeColor,
	extractFullCountyFipsCodes, deriveAlertImpactCategories, extractStateCode, dedupeStrings,
} from '../utils';
import { isAuthenticated, parseRequestBody, getAdminPassword, buildAdminSessionCookie, createAdminSession } from './auth';
import { syncAlerts, readAlertMap } from '../nws';
import {
	readFbAppConfig, readFbAutoPostConfig,
	normalizeFbAutoPostConfig, buildFbAutoPostStatusText,
	fbAutoPostModeHelp, fbAutoPostModeLabel,
	matchingMetroNamesForAlert,
} from '../facebook/config';
import { publishFeatureToFacebook } from '../facebook/api';
import { buildAdminFacebookPostRankings } from '../facebook/ranking';
import { readExistingThreadForFeature } from '../facebook/threads';
import { buildFacebookUpdateCommentMessage } from '../facebook/text';
import { buildAdminStyles } from './styles';

export function renderLoginPage(errorMessage?: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Admin Login - Live Weather Alerts</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; }
.container { max-width: 420px; margin: auto; background: #fff; border-radius: 8px; border:1px solid #ddd; padding: 22px; }
input[type=password], button { width: 100%; padding: 10px; margin-top: 8px; font-size: 16px; }
button { background: #0077cc; border: 0; color: #fff; cursor: pointer; }
.error { color: #b30000; }
</style>
</head>
<body>
<div class="container">
<h2>Admin Login</h2>
${errorMessage ? `<p class="error">${safeHtml(errorMessage)}</p>` : ''}
<form method="post" action="/admin/login">
	<label>Password</label>
	<input type="password" name="password" required />
	<button type="submit">Enter</button>
</form>
</div>
</body>
</html>`;
}

export function renderAdminPage(
	alerts: any[],
	lastPoll?: string,
	syncError?: string,
	appConfig?: FbAppConfig,
	autoPostConfig?: FbAutoPostConfig,
): string {
	const savedAppId = appConfig?.appId ?? '';
	const savedAppSecret = appConfig?.appSecret ? '********' : '';
	const normalizedAutoPostConfig = normalizeFbAutoPostConfig(autoPostConfig);
	const autoPostStatusText = buildFbAutoPostStatusText(normalizedAutoPostConfig);
	// Build post text map keyed by numeric index.
	// We NEVER inject post text into onclick attributes — NWS text contains quotes,
	// apostrophes, and special chars that break HTML attribute parsing. Instead we
	// embed all texts in a JS data object via JSON.stringify (which handles all
	// escaping) and look them up by a simple numeric key from a data-* attribute.
	const postTextMap: Record<string, string> = {};
	const postKeyByAlertId: Record<string, string> = {};
	const states = new Set<string>();
	const severities = new Set<string>();
	const severityCounts = alerts.reduce(
		(acc, feature) => {
			const severity = String(feature?.properties?.severity ?? '').trim().toLowerCase();
			if (severity === 'extreme') acc.extreme += 1;
			else if (severity === 'severe') acc.severe += 1;
			else if (severity === 'moderate') acc.moderate += 1;
			else if (severity === 'minor') acc.minor += 1;
			else acc.unknown += 1;
			return acc;
		},
		{
			extreme: 0,
			severe: 0,
			moderate: 0,
			minor: 0,
			unknown: 0,
		},
	);

	const cards = alerts.map((feature, idx) => {
		const p      = feature.properties ?? {};
		const jsKey  = String(idx);
		const rawId  = String(feature.id ?? '');
		const sev    = String(p.severity ?? '');
		const state  = extractStateCode(feature);
		const searchText = (
			String(p.event ?? '') + ' ' +
			String(p.areaDesc ?? '') + ' ' +
			String(p.headline ?? '') + ' ' +
			String(p.description ?? '')
		).toLowerCase();
		const maxWind = mapSomeValue(findProperty(p, 'maxWindGust') ?? '');
		const maxHailRaw = mapSomeValue(findProperty(p, 'maxHailSize') ?? '');
		const maxHailDisplay = maxHailRaw ? hailDesc(maxHailRaw) : '';

		if (state) states.add(state);
		if (sev) severities.add(sev.toLowerCase());

		// Generate formatted post text and store in map — never interpolated into HTML attrs
		postTextMap[jsKey] = alertToText(p);
		if (rawId) {
			postKeyByAlertId[rawId] = jsKey;
		}

		// The post preview shown in the details panel is the exact same text
		// that will appear in the modal and be posted to Facebook
		const previewText = safeHtml(postTextMap[jsKey]);

		const metaRows = [
			'<p><strong>Urgency:</strong> ' + safeHtml(String(p.urgency ?? '')) + '</p>',
			'<p><strong>Certainty:</strong> ' + safeHtml(String(p.certainty ?? '')) + '</p>',
			'<p><strong>Severity:</strong> ' + safeHtml(sev) + '</p>',
			'<p><strong>Effective:</strong> ' + safeHtml(p.effective ? formatDateTime(p.effective) : '\u2014') + '</p>',
			'<p><strong>Expires:</strong> ' + safeHtml(p.expires ? formatDateTime(p.expires) : '\u2014') + '</p>',
			'<p><strong>Onset:</strong> ' + safeHtml(p.onset ? formatDateTime(p.onset) : '\u2014') + '</p>',
			maxWind ? '<p><strong>Max Wind Gust:</strong> ' + safeHtml(maxWind) + '</p>' : '',
			maxHailDisplay ? '<p><strong>Max Hail Size:</strong> ' + safeHtml(maxHailDisplay) + '</p>' : '',
			'<p><strong>NWS URL:</strong> <a href="' + safeHtml(String(p['@id'] ?? rawId)) + '" target="_blank">View on weather.gov</a></p>',
		].filter(Boolean).join('\n        ');

		return (
			'<div class="alert-card sev-' + safeHtml(sev.toLowerCase()) + '" data-state="' + safeHtml(state) + '" data-event="' + safeHtml(String(p.event ?? '')) + '" data-severity="' + safeHtml(sev.toLowerCase()) + '" data-search="' + safeHtml(searchText) + '">\n' +
			'  <div class="card-header">\n' +
			'    <div class="card-title">\n' +
			'      <span class="badge" style="background:' + severityBadgeColor(sev) + '">' + safeHtml(sev.toUpperCase()) + '</span>\n' +
			'      <strong>' + safeHtml(String(p.event ?? 'Alert')) + '</strong>\n' +
			'      <span class="area">' + safeHtml(String(p.areaDesc ?? '')) + '</span>\n' +
			'    </div>\n' +
			'    <div class="card-meta">\n' +
			'      <span>Status: ' + safeHtml(String(p.status ?? '')) + '</span>\n' +
			'      <span>Expires: ' + safeHtml(p.expires ? formatDateTime(p.expires) : '\u2014') + '</span>\n' +
			'    </div>\n' +
			'  </div>\n' +
			'  <details class="card-details">\n' +
			'    <summary>Show details &amp; post preview</summary>\n' +
			'    <div class="details-grid">\n' +
			'      <div class="detail-col">\n' +
			'        ' + metaRows + '\n' +
			'      </div>\n' +
			'      <div class="detail-col">\n' +
			'        <p><strong>Facebook Post Preview:</strong></p>\n' +
			'        <pre class="post-preview">' + previewText + '</pre>\n' +
			'      </div>\n' +
			'    </div>\n' +
			'  </details>\n' +
			'  <div class="card-actions">\n' +
			// data-key is a safe numeric string; data-id is the NWS URN but only read
			// by JS — it is NOT interpolated into JS source code directly.
			'    <button class="btn-preview" data-key="' + jsKey + '" data-id="' + safeHtml(rawId) + '" data-state="' + safeHtml(state) + '" data-event="' + safeHtml(String(p.event ?? '')) + '" onclick="openPreview(this)">Preview &amp; Post to Facebook</button>\n' +
			'  </div>\n' +
			'</div>'
		);
	}).join('\n');

	// JSON.stringify fully escapes all characters including quotes, backslashes,
	// and newlines — safe to embed directly in a <script> block.
	const postTextsJs = 'const POST_TEXTS = ' + JSON.stringify(postTextMap) + ';';
	const autoPostConfigJs = 'const AUTO_POST_CONFIG = ' + JSON.stringify(
		normalizedAutoPostConfig,
	) + ';';
	const adminForecastConfigJs = 'const ADMIN_FORECAST_LOCATIONS = ' + JSON.stringify(ADMIN_FORECAST_LOCATIONS) + ';';
	const adminConvectiveOutlookConfigJs = 'const ADMIN_CONVECTIVE_OUTLOOKS = ' + JSON.stringify(ADMIN_CONVECTIVE_OUTLOOKS) + ';';

	const stateOptions = Array.from(states).sort().map((s) =>
		'<option value="' + safeHtml(s) + '">' + safeHtml(s) + '</option>'
	).join('');

	const severityOptions = Array.from(severities).sort().map((s) =>
		'<option value="' + safeHtml(s) + '">' + safeHtml(s.toUpperCase()) + '</option>'
	).join('');
	const statsMarkup = [
		{ label: 'Total', count: alerts.length, color: '#1f2937' },
		{ label: 'Extreme', count: severityCounts.extreme, color: severityBadgeColor('extreme') },
		{ label: 'Severe', count: severityCounts.severe, color: severityBadgeColor('severe') },
		{ label: 'Moderate', count: severityCounts.moderate, color: severityBadgeColor('moderate') },
		{ label: 'Minor', count: severityCounts.minor, color: severityBadgeColor('minor') },
		{ label: 'Unknown', count: severityCounts.unknown, color: severityBadgeColor('') },
	].map((item) =>
		'<div class="stat-card" style="border-left-color:' + safeHtml(item.color) + '">\n' +
		'  <div class="stat-label">' + safeHtml(item.label) + '</div>\n' +
		'  <div class="stat-value">' + safeHtml(String(item.count)) + '</div>\n' +
		'</div>'
	).join('\n');
	const forecastLocationTabs = ADMIN_FORECAST_LOCATIONS.map((location, index) =>
		'<button class="forecast-loc-tab' + (index === 0 ? ' is-active' : '') + '" type="button" data-forecast-view="' + safeHtml(location.id) + '">\n' +
		'  <span class="forecast-loc-label">' + safeHtml(location.label) + '</span>\n' +
		'  <span class="forecast-loc-region">' + safeHtml(location.region) + ' • ' + safeHtml(location.zip) + '</span>\n' +
		'</button>'
	).join('\n');
	const discussionLocationTabs = ADMIN_FORECAST_LOCATIONS.map((location, index) =>
		'<button class="forecast-loc-tab discussion-loc-tab' + (index === 0 ? ' is-active' : '') + '" type="button" data-discussion-view="' + safeHtml(location.id) + '">\n' +
		'  <span class="forecast-loc-label">' + safeHtml(location.label) + '</span>\n' +
		'  <span class="forecast-loc-region">' + safeHtml(location.region) + '</span>\n' +
		'  <span class="discussion-tab-count" data-discussion-tab-count="' + safeHtml(location.id) + '">Loading discussions...</span>\n' +
		'</button>'
	).join('\n');
	const convectiveOutlookTabs = ADMIN_CONVECTIVE_OUTLOOKS.map((day, index) =>
		'<button class="forecast-loc-tab outlook-day-tab' + (index === 0 ? ' is-active' : '') + '" type="button" data-outlook-view="' + safeHtml(day.id) + '">\n' +
		'  <span class="forecast-loc-label">' + safeHtml(day.label) + ' Convective Outlook</span>\n' +
		'  <span class="forecast-loc-region" data-outlook-tab-meta="' + safeHtml(day.id) + '">SPC image + discussion</span>\n' +
		'</button>'
	).join('\n');
	const facebookPostRankings = buildAdminFacebookPostRankings(alerts);
	const facebookBucketCounts = facebookPostRankings.reduce(
		(acc, item) => {
			acc[item.bucket] = (acc[item.bucket] || 0) + 1;
			return acc;
		},
		{
			post_now: 0,
			fallback_pick: 0,
			manual_review: 0,
			unlikely: 0,
		} as Record<AdminFacebookPostRankBucket, number>,
	);
	const facebookBucketStats = [
		{ label: 'Would auto-post', count: facebookBucketCounts.post_now, color: '#047857' },
		{ label: 'Fallback picks', count: facebookBucketCounts.fallback_pick, color: '#2563eb' },
		{ label: 'Manual review', count: facebookBucketCounts.manual_review, color: '#b45309' },
		{ label: 'Unlikely', count: facebookBucketCounts.unlikely, color: '#64748b' },
	].map((item) =>
		'<div class="stat-card" style="border-left-color:' + safeHtml(item.color) + '">\n' +
		'  <div class="stat-label">' + safeHtml(item.label) + '</div>\n' +
		'  <div class="stat-value">' + safeHtml(String(item.count)) + '</div>\n' +
		'</div>'
	).join('\n');
	const facebookPostCards = facebookPostRankings.map((item) => {
		const properties = item.feature?.properties ?? {};
		const postKey = postKeyByAlertId[item.alertId] ?? '';
		const event = String(properties.event ?? item.event ?? 'Alert');
		const state = extractStateCode(item.feature);
		const areaDesc = String(properties.areaDesc ?? '');
		const headline = String(properties.headline ?? '');
		const bucketClass = 'fb-rank-' + safeHtml(item.bucket);
		const bucketLabelClass = item.bucket === 'post_now'
			? 'is-post-now'
			: item.bucket === 'fallback_pick'
				? 'is-fallback'
				: item.bucket === 'manual_review'
					? 'is-review'
					: 'is-unlikely';
		const detailTags = [
			item.matchedMetroNames.length > 0 ? 'Metro: ' + item.matchedMetroNames.join(', ') : '',
			item.countyCount > 0 ? 'Counties: ' + item.countyCount : '',
			properties.expires ? 'Expires: ' + formatDateTimeShort(String(properties.expires)) : '',
			properties.severity ? 'Severity: ' + String(properties.severity) : '',
		].filter(Boolean).map((tag) =>
			'<span class="fb-rank-tag">' + safeHtml(tag) + '</span>'
		).join('');
		const previewButton = postKey
			? '<button class="btn-preview" data-key="' + safeHtml(postKey) + '" data-id="' + safeHtml(item.alertId) + '" data-state="' + safeHtml(state) + '" data-event="' + safeHtml(event) + '" onclick="openPreview(this)">Preview &amp; Post to Facebook</button>'
			: '';

		return (
			'<div class="fb-rank-card ' + bucketClass + '">\n' +
			'  <div class="fb-rank-head">\n' +
			'    <div>\n' +
			'      <div class="fb-rank-topline">\n' +
			'        <span class="fb-rank-pill ' + bucketLabelClass + '">' + safeHtml(item.bucketLabel) + '</span>\n' +
			'        <span class="fb-rank-score">Priority ' + safeHtml(String(item.score)) + '</span>\n' +
			'      </div>\n' +
			'      <h3>' + safeHtml(event) + '</h3>\n' +
			'      <p class="fb-rank-area">' + safeHtml(areaDesc || 'Area unavailable') + '</p>\n' +
			(headline ? '      <p class="fb-rank-headline">' + safeHtml(headline) + '</p>\n' : '') +
			'    </div>\n' +
			'  </div>\n' +
			'  <p class="fb-rank-reason"><strong>Why:</strong> ' + safeHtml(item.reasonText) + '</p>\n' +
			(detailTags ? '  <div class="fb-rank-tags">' + detailTags + '</div>\n' : '') +
			(previewButton ? '  <div class="fb-rank-actions">' + previewButton + '</div>\n' : '') +
			'</div>'
		);
	}).join('\n');

	const css = buildAdminStyles();

	const js = postTextsJs + '\n' + autoPostConfigJs + '\n' + adminForecastConfigJs + '\n' + adminConvectiveOutlookConfigJs + `
let currentAlertId = null;
let currentAlertKey = null;
let currentThreadAction = 'new_post'; // 'new_post' | 'comment'
let currentPostId = null;
let currentImageUrl = null;
const ADMIN_FILTERS_STORAGE_KEY = 'liveWeatherAdminFilters:v1';
let currentAdminPanel = 'alerts';
let currentForecastView = (ADMIN_FORECAST_LOCATIONS[0] && ADMIN_FORECAST_LOCATIONS[0].id) || 'forecast-summary';
let currentDiscussionView = (ADMIN_FORECAST_LOCATIONS[0] && ADMIN_FORECAST_LOCATIONS[0].id) || '';
let currentOutlookView = (ADMIN_CONVECTIVE_OUTLOOKS[0] && ADMIN_CONVECTIVE_OUTLOOKS[0].id) || '';
let forecastHubData = null;
let discussionsHubData = null;
let convectiveOutlookHubData = null;
let forecastSummaryEditable = false;
let forecastSummaryDraft = '';

const STATE_CODE_TO_NAME = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri',
  MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new-hampshire', NJ: 'new-jersey',
  NM: 'new-mexico', NY: 'new-york', NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina',
  SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming',
  DC: 'district-of-columbia'
};

function stateCodeToName(code) {
  const c = String(code || '').toUpperCase();
  return STATE_CODE_TO_NAME[c] || '';
}

function alertImageCategory(event) {
  const e = String(event || '').toLowerCase();
  const compact = normalizeEventSlugClient(e).replace(/-/g, '');
  if (e.includes('advisory') || /advi-?ory/.test(e) || compact.includes('advisory')) return 'advisory';
  if (e.includes('outlook') || /outl?ook/.test(e) || compact.includes('outlook')) return 'outlook';
  if (e.includes('warning') || /warnin?g/.test(e) || compact.includes('warning')) return 'warning';
  if (e.includes('watch') || /watc?h/.test(e) || compact.includes('watch')) return 'watch';
  return 'other';
}

function slugify(text) {
  return String(text || '').toLowerCase().trim().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function expandEventSlugs(eventSlug) {
  const variants = new Set();
  const s = String(eventSlug || '').trim().toLowerCase();
  if (!s) return [];
  variants.add(s);

  const accelerants = ['watch', 'warning', 'advisory', 'statement', 'outlook'];
  for (const suffix of accelerants) {
    if (s.endsWith(suffix) && !s.endsWith('-' + suffix)) {
      const base = s.slice(0, -suffix.length);
      if (base) variants.add(base + '-' + suffix);
    }
  }

  if (s.includes('-')) {
    variants.add(s.replace(/-/g, ''));
  } else {
    variants.add(s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
  }

  return Array.from(variants);
}

function normalizeEventSlugClient(raw) {
  let slug = slugify(raw);
  if (!slug) return '';
  slug = slug.replace(/advi-?ory/g, 'advisory');
  slug = slug.replace(/warnin?g?/g, 'warning');
  slug = slug.replace(/floodwatch/g, 'flood-watch');
  slug = slug.replace(/high-?surf/g, 'high-surf');
  slug = slug.replace(/windadvi-?ory/g, 'wind-advisory');
  return slug;
}

function getEventSlugVariants(event, eventSlug) {
  const slugs = new Set();
  if (!eventSlug) eventSlug = slugify(event || '');
  if (!eventSlug) return [];

  slugs.add(eventSlug);
  for (const expanded of expandEventSlugs(eventSlug)) {
    slugs.add(expanded);
  }

  if (eventSlug.includes('-')) {
    slugs.add(eventSlug.replace(/-/g, ''));
  } else {
    slugs.add(eventSlug.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
  }

  if (eventSlug.startsWith('pecial')) {
    slugs.add('s' + eventSlug);
  }
  if (eventSlug.endsWith('-tatement')) {
    slugs.add(eventSlug.replace(/-tatement$/, '-statement'));
  } else if (eventSlug.endsWith('tatement')) {
    slugs.add(eventSlug.replace(/tatement$/, 'statement'));
  }
  const withSpecialPrefix = eventSlug.replace(/^pecial/, 'special');
  if (withSpecialPrefix !== eventSlug) {
    slugs.add(withSpecialPrefix);
    if (withSpecialPrefix.endsWith('-tatement')) {
      slugs.add(withSpecialPrefix.replace(/-tatement$/, '-statement'));
    } else if (withSpecialPrefix.endsWith('tatement')) {
      slugs.add(withSpecialPrefix.replace(/tatement$/, 'statement'));
    }
  }

  const normalizedEvent = String(event || '').toLowerCase();
  if (/\\bspecial\\s+weather\\s+statement\\b/.test(normalizedEvent)) {
    slugs.add('special-weather-statement');
    slugs.add('specialweatherstatement');
  }

  return Array.from(slugs);
}

function getImageCandidates(state, event) {
  const stateSlug = slugify(state);
  const eventSlug = normalizeEventSlugClient(event);
  const category = slugify(alertImageCategory(event));
  const eventSlugs = getEventSlugVariants(event, eventSlug);

  const list = [];
  if (stateSlug) {
    for (const slug of eventSlugs) {
      if (!slug) continue;
      list.push('/images/' + stateSlug + '/' + slug + '-' + stateSlug + '.jpg');
    }
    if (category) {
      list.push('/images/' + stateSlug + '/' + category + '-' + stateSlug + '.jpg');
    }
  }

  if (category) {
    for (const slug of eventSlugs) {
      if (!slug) continue;
      list.push('/images/' + category + '/' + slug + '-' + category + '.jpg');
    }
    if (stateSlug) {
      list.push('/images/' + category + '/weather-' + category + '-' + stateSlug + '.jpg');
      list.push('/images/' + category + '/' + category + '-' + stateSlug + '.jpg');
    }
    list.push('/images/' + category + '/' + category + '.jpg');
  }

  for (const slug of eventSlugs) {
    if (!slug) continue;
    list.push('/images/' + slug + '.jpg');
  }

  const candidates = Array.from(new Set(list));
  for (const path of list) {
    if (path.startsWith('/images/')) {
      candidates.push(path.replace('/images', ''));
    }
  }
  return candidates;
}

async function findPreviewImageUrl(state, event) {
  const candidates = getImageCandidates(state, event);
  for (const relative of candidates) {
    try {
      const url = new URL(relative, window.location.origin).toString();
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
      if (res.status === 404 || res.status === 410) continue;
      if (res.status === 405 || res.status === 501) {
        const getRes = await fetch(url, { method: 'GET' });
        if (getRes.ok) return url;
      }
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function setPreviewImage(state, event) {
  const img = document.getElementById('fbPreviewImage');
  const area = document.getElementById('fbPreviewImageArea');
  if (!img || !area) return;
  img.removeAttribute('src');
  area.style.display = 'none';
  currentImageUrl = null;
  const candidate = await findPreviewImageUrl(state, event);
  if (candidate) {
    img.src = candidate;
    area.style.display = 'block';
    currentImageUrl = candidate;
  }
}

async function openPreview(btn) {
  const key = btn.getAttribute('data-key');
  currentAlertKey = key;
  currentAlertId = btn.getAttribute('data-id');
  currentThreadAction = 'new_post';
  currentPostId = null;

  const alertCard = btn.closest('.alert-card');
  const cardState = btn.getAttribute('data-state') || alertCard?.getAttribute('data-state') || '';
  const cardEvent = btn.getAttribute('data-event') || alertCard?.getAttribute('data-event') || '';
  const stateFolder = stateCodeToName(cardState) || cardState.toLowerCase();
  setPreviewImage(stateFolder, cardEvent);

  document.getElementById('fbText').value = POST_TEXTS[key] || '';
  document.getElementById('postStatus').className = 'post-status';
  document.getElementById('postStatus').textContent = '';
  const postBtn = document.getElementById('btnPost');
  postBtn.disabled = false;
  postBtn.textContent = 'Post to Facebook';
  updateCharCount();

  // Show modal immediately — thread check updates the header async
  setThreadIndicator('checking', null);
  document.getElementById('fbModal').classList.add('open');

  // Check for existing thread
  try {
    const res = await fetch('/admin/thread-check?alertId=' + encodeURIComponent(currentAlertId || ''));
    const data = await res.json();
    if (data.action === 'comment' && data.threadInfo) {
      currentThreadAction = 'comment';
      currentPostId = data.postId;
      setThreadIndicator('comment', data.threadInfo);
      if ((data.threadInfo.updateCount ?? 0) < 3 && data.suggestedCommentText) {
        document.getElementById('fbText').value = String(data.suggestedCommentText || '');
        updateCharCount();
      }
      // Button text is set inside setThreadIndicator based on updateCount
    } else {
      currentThreadAction = 'new_post';
      setThreadIndicator('new_post', null);
      document.getElementById('fbText').value = POST_TEXTS[key] || '';
      updateCharCount();
      postBtn.textContent = 'Post to Facebook';
    }
  } catch (e) {
    // Thread check failed — default to new post
    currentThreadAction = 'new_post';
    setThreadIndicator('new_post', null);
    document.getElementById('fbText').value = POST_TEXTS[key] || '';
    updateCharCount();
  }
}

function setThreadIndicator(state, threadInfo) {
  const el = document.getElementById('threadIndicator');
  const postBtn = document.getElementById('btnPost');
  if (state === 'checking') {
    el.className = 'thread-indicator checking';
    el.textContent = 'Checking for existing thread...';
  } else if (state === 'comment' && threadInfo) {
    const updateCount = threadInfo.updateCount ?? 0;
    const remaining = 3 - updateCount;
    const atLimit = remaining <= 0;
    currentThreadAction = atLimit ? 'new_post' : 'comment';
    el.className = 'thread-indicator is-comment';
    const countLabel = atLimit
      ? '<strong>Chain limit reached</strong> — will create a new post'
      : '&#128172; <strong>Adding comment</strong> to existing thread (' + remaining + ' update' + (remaining === 1 ? '' : 's') + ' before chain break)';
    el.innerHTML = countLabel + ' &mdash; ' + escHtml(threadInfo.alertType) +
      ' &mdash; Post: <a href="https://www.facebook.com/' + escHtml(threadInfo.postId) + '" target="_blank">' +
      escHtml(threadInfo.postId) + '</a>' +
      ' <button class="btn-force-new" onclick="forceNewPost()">Force new post instead</button>';
    postBtn.textContent = atLimit ? 'Post (New Thread)' : 'Post Comment';
  } else {
    currentThreadAction = 'new_post';
    el.className = 'thread-indicator is-new';
    el.textContent = 'Creating new Facebook post';
  }
}

function forceNewPost() {
  currentThreadAction = 'new_post';
  currentPostId = null;
  setThreadIndicator('new_post', null);
  document.getElementById('fbText').value = POST_TEXTS[currentAlertKey] || '';
  updateCharCount();
  document.getElementById('btnPost').textContent = 'Post to Facebook';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function closeModal() {
  document.getElementById('fbModal').classList.remove('open');
  currentAlertId = null;
  currentAlertKey = null;
  currentThreadAction = 'new_post';
  currentPostId = null;
  currentImageUrl = null;
}

function updateCharCount() {
  document.getElementById('charCount').textContent =
    document.getElementById('fbText').value.length.toLocaleString();
}

async function submitPost() {
  const message = document.getElementById('fbText').value.trim();
  if (!message) return;
  const btn = document.getElementById('btnPost');
  const status = document.getElementById('postStatus');
  btn.disabled = true;
  btn.textContent = currentThreadAction === 'comment' ? 'Posting comment...' : 'Posting...';
  status.className = 'post-status';
  status.textContent = '';
  try {
    const body = new URLSearchParams({
      action: 'post_alert',
      alertId: currentAlertId || '',
      customMessage: message,
      threadAction: currentThreadAction,
    });
    if (currentImageUrl) body.set('imageUrl', currentImageUrl);
    const res = await fetch('/admin/post', { method: 'POST', body });
    const data = await res.json();
    const result = data.results && data.results[0];
    if (result && (result.status === 'posted' || result.status === 'commented')) {
      status.className = 'post-status ok';
      const chainMsg = result.chainBreak ? ' (new thread started)' : '';
      status.textContent = result.status === 'commented'
        ? 'Comment posted successfully!'
        : 'Posted successfully to Facebook!' + chainMsg;
      btn.textContent = result.status === 'commented' ? 'Commented ✓' : 'Posted ✓';
      // Update thread indicator to reflect new state after posting
      if (result.status === 'posted' && result.postId) {
        currentPostId = result.postId;
        currentThreadAction = 'comment';
        setThreadIndicator('comment', { alertType: 'this alert', postId: result.postId, updateCount: 0 });
      } else if (result.status === 'commented' && result.postId) {
        currentPostId = result.postId;
        currentThreadAction = 'comment';
        setThreadIndicator('comment', { alertType: 'this alert', postId: result.postId, updateCount: result.updateCount ?? 0 });
      }
    } else {
      throw new Error((result && result.error) || 'Unknown error');
    }
  } catch (err) {
    status.className = 'post-status err';
    status.textContent = 'Error: ' + err.message;
    btn.disabled = false;
    btn.textContent = currentThreadAction === 'comment' ? 'Post Comment' : 'Post to Facebook';
  }
}

document.getElementById('fbModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function applyFilters() {
  const search = (document.getElementById('filterSearch').value || '').trim().toLowerCase();
  const state = (document.getElementById('filterState').value || 'all').toLowerCase();
  const severity = (document.getElementById('filterSeverity').value || 'all').toLowerCase();

  document.querySelectorAll('.alert-card').forEach((card) => {
    const cardState = (card.getAttribute('data-state') || '').toLowerCase();
    const cardSeverity = (card.getAttribute('data-severity') || '').toLowerCase();
    const cardSearch = (card.getAttribute('data-search') || '').toLowerCase();

    const matchesState = state === 'all' || (!state && !cardState) || cardState === state;
    const matchesSeverity = severity === 'all' || (!severity && !cardSeverity) || cardSeverity === severity;
    const matchesSearch = !search || cardSearch.includes(search);

    card.style.display = (matchesState && matchesSeverity && matchesSearch) ? '' : 'none';
  });

  saveFilters();
}

function clearFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterState').value = 'all';
  document.getElementById('filterSeverity').value = 'all';
  applyFilters();
}

function saveFilters() {
  try {
    const payload = {
      search: (document.getElementById('filterSearch').value || '').trim(),
      state: document.getElementById('filterState').value || 'all',
      severity: document.getElementById('filterSeverity').value || 'all',
    };
    window.localStorage.setItem(ADMIN_FILTERS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures and keep the filters working in-memory.
  }
}

function restoreSavedFilters() {
  try {
    const raw = window.localStorage.getItem(ADMIN_FILTERS_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    const search = document.getElementById('filterSearch');
    const state = document.getElementById('filterState');
    const severity = document.getElementById('filterSeverity');

    if (search && typeof saved.search === 'string') {
      search.value = saved.search;
    }
    if (state && typeof saved.state === 'string') {
      const hasStateOption = Array.from(state.options || []).some((option) => option.value === saved.state);
      state.value = hasStateOption ? saved.state : 'all';
    }
    if (severity && typeof saved.severity === 'string') {
      const hasSeverityOption = Array.from(severity.options || []).some((option) => option.value === saved.severity);
      severity.value = hasSeverityOption ? saved.severity : 'all';
    }
  } catch {
    // Ignore malformed saved filters.
  }
}

const filterSearchInput = document.getElementById('filterSearch');
const filterStateSelect = document.getElementById('filterState');
const filterSeveritySelect = document.getElementById('filterSeverity');
const clearFiltersBtn = document.getElementById('clearFilters');

if (filterSearchInput) filterSearchInput.addEventListener('input', applyFilters);
if (filterStateSelect) filterStateSelect.addEventListener('change', applyFilters);
if (filterSeveritySelect) filterSeveritySelect.addEventListener('change', applyFilters);
if (clearFiltersBtn) clearFiltersBtn.addEventListener('click', clearFilters);

function forecastEscHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setActiveAdminPanel(panelId) {
  currentAdminPanel = panelId === 'forecast' || panelId === 'discussions' || panelId === 'outlook' || panelId === 'facebook-post' ? panelId : 'alerts';
  document.querySelectorAll('[data-admin-panel-btn]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-admin-panel-btn') === currentAdminPanel);
  });
  document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.getAttribute('data-admin-panel') === currentAdminPanel);
  });
  if (currentAdminPanel === 'forecast' && !forecastHubData) {
    loadForecastHub(false);
  }
  if (currentAdminPanel === 'discussions' && !discussionsHubData) {
    loadDiscussionsHub(false);
  }
  if (currentAdminPanel === 'outlook' && !convectiveOutlookHubData) {
    loadConvectiveOutlookHub(false);
  }
}

function formatForecastUpdatedAt(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return 'Updated just now';
  return 'Updated ' + new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function forecastTempLabel(period) {
  if (!Number.isFinite(Number(period && period.temperatureF))) return '--';
  return Math.round(Number(period.temperatureF)) + '°F';
}

function forecastMetaText(period) {
  const items = [];
  const windSpeed = String(period && period.windSpeed || '').trim();
  const windDirection = String(period && period.windDirection || '').trim();
  if (windSpeed || windDirection) {
    items.push([windSpeed, windDirection].filter(Boolean).join(' '));
  }
  if (Number.isFinite(Number(period && period.precipitationChance))) {
    items.push('Precip: ' + Math.round(Number(period.precipitationChance)) + '%');
  }
  return items.map((item) => '<div>' + forecastEscHtml(item) + '</div>').join('');
}

function syncForecastTabs() {
  document.querySelectorAll('[data-forecast-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-forecast-view') === currentForecastView);
  });
}

function renderForecastContent() {
  const host = document.getElementById('forecastHubContent');
  if (!host) return;

  syncForecastTabs();

  if (!forecastHubData) {
    host.innerHTML = '<div class="forecast-city-shell"><p>Loading forecast data...</p></div>';
    return;
  }

  if (currentForecastView === 'forecast-summary') {
    const summaryText = (forecastSummaryDraft || String(forecastHubData.summaryText || '')).trim();
    const errorCount = Array.isArray(forecastHubData.errors) ? forecastHubData.errors.length : 0;
    host.innerHTML =
      '<div class="forecast-summary-card">' +
      '  <div class="forecast-summary-head">' +
      '    <div>' +
      '      <h3>' + forecastEscHtml(forecastHubData.summaryTitle || '3-Day USA Forecast') + '</h3>' +
      '      <p class="forecast-updated">' + forecastEscHtml(formatForecastUpdatedAt(forecastHubData.generatedAt)) + '</p>' +
      '    </div>' +
      '    <div class="forecast-summary-actions">' +
      '      <button type="button" id="copyForecastSummary" class="primary">Copy for Facebook</button>' +
      '      <button type="button" id="toggleForecastSummaryEdit">Edit</button>' +
      '      <button type="button" id="refreshForecastSummary" class="accent">Generate New</button>' +
      '    </div>' +
      '  </div>' +
      '  <textarea id="forecastSummaryEditor" class="forecast-summary-editor"' + (forecastSummaryEditable ? '' : ' readonly') + '>' + forecastEscHtml(summaryText) + '</textarea>' +
      '  <div class="forecast-summary-meta">' + forecastEscHtml(errorCount > 0 ? ('Loaded with ' + errorCount + ' forecast issue' + (errorCount === 1 ? '' : 's') + '.') : 'Built from the latest Northeast, Southeast, Midwest, Plains, and West city forecasts.') + '</div>' +
      '</div>';

    const copyBtn = document.getElementById('copyForecastSummary');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function() {
        const editor = document.getElementById('forecastSummaryEditor');
        const text = editor ? editor.value : summaryText;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else if (editor) {
            editor.select();
            document.execCommand('copy');
          }
          const status = document.getElementById('forecastHubStatus');
          if (status) {
            status.className = 'forecast-status';
            status.textContent = 'Forecast summary copied to clipboard.';
          }
        } catch (err) {
          const status = document.getElementById('forecastHubStatus');
          if (status) {
            status.className = 'forecast-status err';
            status.textContent = 'Unable to copy forecast summary: ' + err;
          }
        }
      });
    }

    const editBtn = document.getElementById('toggleForecastSummaryEdit');
    if (editBtn) {
      editBtn.textContent = forecastSummaryEditable ? 'Done Editing' : 'Edit';
      editBtn.addEventListener('click', function() {
        forecastSummaryEditable = !forecastSummaryEditable;
        renderForecastContent();
      });
    }

    const refreshBtn = document.getElementById('refreshForecastSummary');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        loadForecastHub(true);
      });
    }

    const summaryEditor = document.getElementById('forecastSummaryEditor');
    if (summaryEditor) {
      summaryEditor.addEventListener('input', function() {
        forecastSummaryDraft = summaryEditor.value;
      });
    }
    return;
  }

  const city = Array.isArray(forecastHubData.cities)
    ? forecastHubData.cities.find((entry) => entry.id === currentForecastView)
    : null;
  if (!city) {
    host.innerHTML = '<div class="forecast-city-shell"><p>Select a city tab to view its forecast.</p></div>';
    return;
  }

  const periodsMarkup = (Array.isArray(city.periods) ? city.periods : []).map((period) =>
    '<article class="forecast-period-card' + (!period.isDaytime ? ' is-night' : '') + '">' +
    '  <div>' +
    '    <h4>' + forecastEscHtml(period.name || 'Forecast Period') + '</h4>' +
    '    <p class="forecast-short">' + forecastEscHtml(period.shortForecast || '') + '</p>' +
    '    <p class="forecast-detail">' + forecastEscHtml(period.detailedForecast || '') + '</p>' +
    '  </div>' +
    '  <div class="forecast-period-side">' +
    '    <div class="forecast-period-temp">' + forecastEscHtml(forecastTempLabel(period)) + '</div>' +
    '    <div class="forecast-period-meta">' + forecastMetaText(period) + '</div>' +
    '  </div>' +
    '</article>'
  ).join('');

  host.innerHTML =
    '<div class="forecast-city-shell">' +
    '  <div class="forecast-city-head">' +
    '    <div>' +
    '      <h3>' + forecastEscHtml(city.label) + ' Forecast</h3>' +
    '      <p>' + forecastEscHtml(city.region + ' • ' + city.locationLabel + ' • ZIP ' + city.zip) + '</p>' +
    '    </div>' +
    '    <div class="forecast-updated">' + forecastEscHtml(formatForecastUpdatedAt(city.updated)) + '</div>' +
    '  </div>' +
    '  <div class="forecast-periods">' + periodsMarkup + '</div>' +
    '</div>';
}

async function loadForecastHub(forceRefresh) {
  const status = document.getElementById('forecastHubStatus');
  const refreshBtn = document.getElementById('forecastRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;
  if (status) {
    status.className = 'forecast-status';
    status.textContent = forceRefresh ? 'Refreshing forecast data...' : 'Loading forecast data...';
  }

  try {
    const response = await fetch('/admin/forecast-data');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to load forecast data');
    }
    forecastHubData = data;
    forecastSummaryDraft = String(data.summaryText || '');
    const cityIds = Array.isArray(data.cities) ? data.cities.map((entry) => entry.id) : [];
    if (currentForecastView !== 'forecast-summary' && !cityIds.includes(currentForecastView)) {
      currentForecastView = cityIds[0] || 'forecast-summary';
    }
    renderForecastContent();
    if (status) {
      const issueCount = Array.isArray(data.errors) ? data.errors.length : 0;
      status.className = issueCount > 0 ? 'forecast-status err' : 'forecast-status';
      status.textContent = issueCount > 0
        ? 'Loaded forecast data with ' + issueCount + ' issue' + (issueCount === 1 ? '' : 's') + '.'
        : 'Forecast data is up to date.';
    }
  } catch (err) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to load forecast data: ' + (err instanceof Error ? err.message : String(err));
    }
    const host = document.getElementById('forecastHubContent');
    if (host) {
      host.innerHTML = '<div class="forecast-city-shell"><p>Forecast data is unavailable right now.</p></div>';
    }
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function formatDiscussionIssuedAt(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return 'Issued recently';
  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function syncDiscussionTabs() {
  document.querySelectorAll('[data-discussion-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-discussion-view') === currentDiscussionView);
  });

  if (!discussionsHubData || !Array.isArray(discussionsHubData.cities)) return;
  discussionsHubData.cities.forEach((city) => {
    const countEl = document.querySelector('[data-discussion-tab-count="' + city.id + '"]');
    if (countEl) {
      countEl.textContent = String(city.discussionCount || 0) + ' discussions';
    }
  });
}

function findDiscussionEntry(cityId, discussionId) {
  if (!discussionsHubData || !Array.isArray(discussionsHubData.cities)) return null;
  const city = discussionsHubData.cities.find((entry) => entry.id === cityId);
  if (!city || !Array.isArray(city.discussions)) return null;
  return city.discussions.find((entry) => entry.id === discussionId) || null;
}

async function copyDiscussionContent(cityId, discussionId, kind) {
  const discussion = findDiscussionEntry(cityId, discussionId);
  const status = document.getElementById('discussionHubStatus');
  if (!discussion) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to find that discussion entry.';
    }
    return;
  }

  const text = kind === 'facebook'
    ? String(discussion.facebookText || discussion.productText || '').trim()
    : String(discussion.productText || '').trim();

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
    if (status) {
      status.className = 'forecast-status';
      status.textContent = kind === 'facebook'
        ? 'Discussion copied in Facebook-ready format.'
        : 'Discussion text copied to clipboard.';
    }
  } catch (err) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to copy discussion text: ' + err;
    }
  }
}

function renderDiscussionsContent() {
  const host = document.getElementById('discussionHubContent');
  if (!host) return;

  syncDiscussionTabs();

  if (!discussionsHubData) {
    host.innerHTML = '<div class="discussion-empty">Loading NWS discussions...</div>';
    return;
  }

  const city = Array.isArray(discussionsHubData.cities)
    ? discussionsHubData.cities.find((entry) => entry.id === currentDiscussionView)
    : null;

  if (!city) {
    host.innerHTML = '<div class="discussion-empty">Select a city tab to view its Area Forecast Discussions.</div>';
    return;
  }

  const discussions = Array.isArray(city.discussions) ? city.discussions : [];
  if (discussions.length === 0) {
    host.innerHTML = '<div class="discussion-empty">No discussions are available for ' + forecastEscHtml(city.label) + ' right now.</div>';
    return;
  }

  const cards = discussions.map((discussion, index) =>
    '<details class="discussion-card"' + (index === 0 ? ' open' : '') + ' data-discussion-card>' +
    '  <summary>' +
    '    <div>' +
    '      <div class="discussion-title">' + forecastEscHtml(discussion.title || 'Area Forecast Discussion') + '</div>' +
    '      <div class="discussion-issued">' + forecastEscHtml(formatDiscussionIssuedAt(discussion.issuanceTime)) + '</div>' +
    '    </div>' +
    '    <div class="discussion-toggle" data-discussion-toggle-label>' + (index === 0 ? 'Collapse' : 'Expand') + '</div>' +
    '  </summary>' +
    '  <div class="discussion-body-wrap">' +
    '    <pre class="discussion-body">' + forecastEscHtml(discussion.productText || '') + '</pre>' +
    '    <div class="discussion-actions">' +
    '      <button type="button" data-discussion-copy="raw" data-city-id="' + forecastEscHtml(city.id) + '" data-discussion-id="' + forecastEscHtml(discussion.id) + '">Copy Text</button>' +
    '      <button type="button" class="primary" data-discussion-copy="facebook" data-city-id="' + forecastEscHtml(city.id) + '" data-discussion-id="' + forecastEscHtml(discussion.id) + '">Copy for Facebook</button>' +
    (discussion.productUrl ? '      <a href="' + forecastEscHtml(discussion.productUrl) + '" target="_blank" rel="noreferrer">Open NOAA Product</a>' : '') +
    '    </div>' +
    '  </div>' +
    '</details>'
  ).join('');

  host.innerHTML =
    '<div class="forecast-city-shell">' +
    '  <div class="forecast-city-head">' +
    '    <div>' +
    '      <h3>' + forecastEscHtml(city.label) + ' NWS Discussions</h3>' +
    '      <p>' + forecastEscHtml(city.region + ' • ' + city.officeLabel + ' (' + city.officeCode + ')') + '</p>' +
    '    </div>' +
    '    <div class="forecast-updated">' + forecastEscHtml(String(city.discussionCount || 0) + ' discussions available') + '</div>' +
    '  </div>' +
    '  <div class="discussion-list">' + cards + '</div>' +
    '</div>';

  host.querySelectorAll('[data-discussion-card]').forEach((details) => {
    details.addEventListener('toggle', function() {
      const label = details.querySelector('[data-discussion-toggle-label]');
      if (label) {
        label.textContent = details.open ? 'Collapse' : 'Expand';
      }
    });
  });

  host.querySelectorAll('[data-discussion-copy]').forEach((btn) => {
    btn.addEventListener('click', function() {
      copyDiscussionContent(
        btn.getAttribute('data-city-id') || '',
        btn.getAttribute('data-discussion-id') || '',
        btn.getAttribute('data-discussion-copy') || 'raw',
      );
    });
  });
}

async function loadDiscussionsHub(forceRefresh) {
  const status = document.getElementById('discussionHubStatus');
  const refreshBtn = document.getElementById('discussionRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;
  if (status) {
    status.className = 'forecast-status';
    status.textContent = forceRefresh ? 'Refreshing NWS discussions...' : 'Loading NWS discussions...';
  }

  try {
    const response = await fetch('/admin/discussions-data');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to load NWS discussions');
    }
    discussionsHubData = data;
    const cityIds = Array.isArray(data.cities) ? data.cities.map((entry) => entry.id) : [];
    if (!cityIds.includes(currentDiscussionView)) {
      currentDiscussionView = cityIds[0] || currentDiscussionView;
    }
    renderDiscussionsContent();
    if (status) {
      const issueCount = Array.isArray(data.errors) ? data.errors.length : 0;
      status.className = issueCount > 0 ? 'forecast-status err' : 'forecast-status';
      status.textContent = issueCount > 0
        ? 'Loaded discussions with ' + issueCount + ' issue' + (issueCount === 1 ? '' : 's') + '.'
        : 'NWS discussions are up to date.';
    }
  } catch (err) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to load NWS discussions: ' + (err instanceof Error ? err.message : String(err));
    }
    const host = document.getElementById('discussionHubContent');
    if (host) {
      host.innerHTML = '<div class="discussion-empty">NWS discussions are unavailable right now.</div>';
    }
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function syncConvectiveOutlookTabs() {
  document.querySelectorAll('[data-outlook-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-outlook-view') === currentOutlookView);
  });

  if (!convectiveOutlookHubData || !Array.isArray(convectiveOutlookHubData.days)) return;
  convectiveOutlookHubData.days.forEach((day) => {
    const metaEl = document.querySelector('[data-outlook-tab-meta="' + day.id + '"]');
    if (metaEl) {
      metaEl.textContent = day.updated || 'SPC image + discussion';
    }
  });
}

function findConvectiveOutlookEntry(dayId) {
  if (!convectiveOutlookHubData || !Array.isArray(convectiveOutlookHubData.days)) return null;
  return convectiveOutlookHubData.days.find((entry) => entry.id === dayId) || null;
}

async function copyConvectiveOutlookContent(dayId, kind) {
  const day = findConvectiveOutlookEntry(dayId);
  const status = document.getElementById('convectiveOutlookStatus');
  if (!day) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to find that convective outlook.';
    }
    return;
  }

  const text = kind === 'facebook'
    ? String(day.facebookText || day.discussionText || '').trim()
    : String(day.discussionText || '').trim();

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement('textarea');
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
    if (status) {
      status.className = 'forecast-status';
      status.textContent = kind === 'facebook'
        ? 'Convective outlook copied in Facebook-ready format.'
        : 'Convective outlook discussion copied to clipboard.';
    }
  } catch (err) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to copy convective outlook text: ' + err;
    }
  }
}

function renderConvectiveOutlookContent() {
  const host = document.getElementById('convectiveOutlookContent');
  if (!host) return;

  syncConvectiveOutlookTabs();

  if (!convectiveOutlookHubData) {
    host.innerHTML = '<div class="outlook-empty">Loading SPC convective outlook data...</div>';
    return;
  }

  const day = Array.isArray(convectiveOutlookHubData.days)
    ? convectiveOutlookHubData.days.find((entry) => entry.id === currentOutlookView)
    : null;

  if (!day) {
    host.innerHTML = '<div class="outlook-empty">Select a day tab to view the latest SPC convective outlook.</div>';
    return;
  }

  host.innerHTML =
    '<div class="forecast-city-shell">' +
    '  <div class="forecast-city-head">' +
    '    <div>' +
    '      <h3>' + forecastEscHtml(day.title || (day.label + ' Convective Outlook')) + '</h3>' +
    '      <p>' + forecastEscHtml((day.pageTitle || '') + (day.issuedLabel ? ' | Issued ' + day.issuedLabel : '')) + '</p>' +
    '    </div>' +
    '    <div class="forecast-updated">' + forecastEscHtml(day.updated ? ('Updated ' + day.updated) : 'SPC current cycle') + '</div>' +
    '  </div>' +
    (day.summary ? '  <div class="outlook-summary">' + forecastEscHtml(day.summary) + '</div>' : '') +
    (day.imageUrl
      ? '  <div class="outlook-image-card"><a class="outlook-image-link" href="' + forecastEscHtml(day.imageUrl) + '" target="_blank" rel="noreferrer"><img class="outlook-image" src="' + forecastEscHtml(day.imageUrl) + '" alt="' + forecastEscHtml(day.title || (day.label + ' Convective Outlook')) + '" /></a></div>'
      : '  <div class="outlook-empty">The SPC outlook image is unavailable right now.</div>') +
    '  <details class="discussion-card" open>' +
    '    <summary>' +
    '      <div>' +
    '        <div class="discussion-title">Forecast Discussion</div>' +
    '        <div class="discussion-issued">' + forecastEscHtml(day.issuedLabel || day.updated || 'Issued recently') + '</div>' +
    '      </div>' +
    '      <div class="discussion-toggle">Collapse</div>' +
    '    </summary>' +
    '    <div class="discussion-body-wrap">' +
    '      <pre class="discussion-body">' + forecastEscHtml(day.discussionText || '') + '</pre>' +
    '      <div class="discussion-actions">' +
    '        <button type="button" data-outlook-copy="raw" data-outlook-id="' + forecastEscHtml(day.id) + '">Copy Text</button>' +
    '        <button type="button" class="primary" data-outlook-copy="facebook" data-outlook-id="' + forecastEscHtml(day.id) + '">Copy for Facebook</button>' +
    (day.pageUrl ? '        <a href="' + forecastEscHtml(day.pageUrl) + '" target="_blank" rel="noreferrer">Open SPC Page</a>' : '') +
    (day.imageUrl ? '        <a href="' + forecastEscHtml(day.imageUrl) + '" target="_blank" rel="noreferrer">Open Image</a>' : '') +
    '      </div>' +
    '    </div>' +
    '  </details>' +
    '</div>';

  host.querySelectorAll('[data-outlook-copy]').forEach((btn) => {
    btn.addEventListener('click', function() {
      copyConvectiveOutlookContent(
        btn.getAttribute('data-outlook-id') || '',
        btn.getAttribute('data-outlook-copy') || 'raw',
      );
    });
  });
}

async function loadConvectiveOutlookHub(forceRefresh) {
  const status = document.getElementById('convectiveOutlookStatus');
  const refreshBtn = document.getElementById('convectiveOutlookRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;
  if (status) {
    status.className = 'forecast-status';
    status.textContent = forceRefresh ? 'Refreshing SPC convective outlooks...' : 'Loading SPC convective outlooks...';
  }

  try {
    const response = await fetch('/admin/convective-outlook-data');
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to load SPC convective outlooks');
    }
    convectiveOutlookHubData = data;
    const dayIds = Array.isArray(data.days) ? data.days.map((entry) => entry.id) : [];
    if (!dayIds.includes(currentOutlookView)) {
      currentOutlookView = dayIds[0] || currentOutlookView;
    }
    renderConvectiveOutlookContent();
    if (status) {
      const issueCount = Array.isArray(data.errors) ? data.errors.length : 0;
      status.className = issueCount > 0 ? 'forecast-status err' : 'forecast-status';
      status.textContent = issueCount > 0
        ? 'Loaded convective outlooks with ' + issueCount + ' issue' + (issueCount === 1 ? '' : 's') + '.'
        : 'SPC convective outlooks are up to date.';
    }
  } catch (err) {
    if (status) {
      status.className = 'forecast-status err';
      status.textContent = 'Unable to load SPC convective outlooks: ' + (err instanceof Error ? err.message : String(err));
    }
    const host = document.getElementById('convectiveOutlookContent');
    if (host) {
      host.innerHTML = '<div class="outlook-empty">SPC convective outlook data is unavailable right now.</div>';
    }
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

document.querySelectorAll('[data-admin-panel-btn]').forEach((btn) => {
  btn.addEventListener('click', function() {
    setActiveAdminPanel(btn.getAttribute('data-admin-panel-btn'));
  });
});

document.querySelectorAll('[data-forecast-view]').forEach((btn) => {
  btn.addEventListener('click', function() {
    currentForecastView = btn.getAttribute('data-forecast-view') || currentForecastView;
    renderForecastContent();
    if (!forecastHubData) {
      loadForecastHub(false);
    }
  });
});

const forecastRefreshBtn = document.getElementById('forecastRefreshBtn');
if (forecastRefreshBtn) {
  forecastRefreshBtn.addEventListener('click', function() {
    loadForecastHub(true);
  });
}

document.querySelectorAll('[data-discussion-view]').forEach((btn) => {
  btn.addEventListener('click', function() {
    currentDiscussionView = btn.getAttribute('data-discussion-view') || currentDiscussionView;
    renderDiscussionsContent();
    if (!discussionsHubData) {
      loadDiscussionsHub(false);
    }
  });
});

const discussionRefreshBtn = document.getElementById('discussionRefreshBtn');
if (discussionRefreshBtn) {
  discussionRefreshBtn.addEventListener('click', function() {
    loadDiscussionsHub(true);
  });
}

document.querySelectorAll('[data-outlook-view]').forEach((btn) => {
  btn.addEventListener('click', function() {
    currentOutlookView = btn.getAttribute('data-outlook-view') || currentOutlookView;
    renderConvectiveOutlookContent();
    if (!convectiveOutlookHubData) {
      loadConvectiveOutlookHub(false);
    }
  });
});

const convectiveOutlookRefreshBtn = document.getElementById('convectiveOutlookRefreshBtn');
if (convectiveOutlookRefreshBtn) {
  convectiveOutlookRefreshBtn.addEventListener('click', function() {
    loadConvectiveOutlookHub(true);
  });
}

setActiveAdminPanel('alerts');
renderForecastContent();
renderDiscussionsContent();
renderConvectiveOutlookContent();

const autoPostModeSelect = document.getElementById('autoPostMode');
const autoPostHelp = document.getElementById('autoPostHelp');
const autoPostStatus = document.getElementById('autoPostStatus');
const AUTO_POST_MODE_HELP = {
  off: 'Automatic Facebook posting is disabled.',
  tornado_only: 'All active, timely Tornado Warnings auto-post and follow the existing Facebook thread/comment rules.',
  smart_high_impact: 'All active, timely Tornado Warnings auto-post. Severe Thunderstorm Warnings and Watches are storm-clustered, so one main post is created per metro/region and same-storm follow-ups become comments instead of duplicate posts. Otherwise Severe Thunderstorm Warnings need metro or 10 counties plus destructive, 70 mph, 2-inch hail, or strong wording. Fire warnings need wildfire or public safety escalation. Flood and winter warnings must pass the base impact gate.',
};

function setAutoPostStatus(message, variant) {
  if (!autoPostStatus) return;
  autoPostStatus.className = variant ? 'auto-post-status ' + variant : 'auto-post-status';
  autoPostStatus.textContent = message;
}

function syncAutoPostHelp() {
  if (!autoPostHelp || !autoPostModeSelect) return;
  autoPostHelp.textContent = AUTO_POST_MODE_HELP[autoPostModeSelect.value] || AUTO_POST_MODE_HELP.off;
}

async function saveAutoPostMode() {
  if (!autoPostModeSelect) return;
  const previousMode = AUTO_POST_CONFIG.mode || 'off';
  autoPostModeSelect.disabled = true;
  setAutoPostStatus('Saving auto-post setting...', '');

  try {
    const response = await fetch('/admin/auto-post-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: autoPostModeSelect.value }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Unable to save auto-post setting');
    }
    AUTO_POST_CONFIG.mode = data.config && data.config.mode ? data.config.mode : autoPostModeSelect.value;
    syncAutoPostHelp();
    setAutoPostStatus(data.message || 'Auto-post setting saved.', 'ok');
  } catch (err) {
    autoPostModeSelect.value = previousMode;
    syncAutoPostHelp();
    const message = err instanceof Error ? err.message : String(err);
    setAutoPostStatus('Error saving auto-post setting: ' + message, 'err');
  } finally {
    autoPostModeSelect.disabled = false;
  }
}

if (autoPostModeSelect) {
  autoPostModeSelect.value = AUTO_POST_CONFIG.mode || 'off';
  syncAutoPostHelp();
  autoPostModeSelect.addEventListener('change', saveAutoPostMode);
}

const btnTokenExchange = document.getElementById('btnTokenExchange');
if (btnTokenExchange) {
  btnTokenExchange.addEventListener('click', async function() {
    const appId = (document.getElementById('tokenAppId') || { value: '' }).value.trim();
    const appSecret = (document.getElementById('tokenAppSecret') || { value: '' }).value.trim();
    const userToken = (document.getElementById('tokenUserToken') || { value: '' }).value.trim();
    const resultEl = document.getElementById('tokenResult');
    if (!resultEl) return;

    if (!appId || !appSecret || !userToken) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'All fields (App ID, App Secret, User Token) are required';
      return;
    }

    resultEl.style.color = '#333';
    resultEl.textContent = 'Exchanging token...';

    try {
      const response = await fetch('/admin/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret, userToken }),
      });
      const data = await response.json();
      if (response.ok && data.access_token) {
        resultEl.style.color = '#1a7f37';
        resultEl.textContent = 'Long-lived token: ' + data.access_token;
      } else {
        resultEl.style.color = '#b30000';
        resultEl.textContent = 'Error exchanging token: ' + (data.error || 'Unknown');
      }
    } catch (err) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'Request failed: ' + err;
    }
  });
}

const btnSaveAppConfig = document.getElementById('btnSaveAppConfig');
if (btnSaveAppConfig) {
  btnSaveAppConfig.addEventListener('click', async function() {
    const appId = (document.getElementById('tokenAppId') || { value: '' }).value.trim();
    const appSecret = (document.getElementById('tokenAppSecret') || { value: '' }).value.trim();
    const resultEl = document.getElementById('tokenResult');
    if (!resultEl) return;

    if (!appId || !appSecret) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'App ID and App Secret are required to save';
      return;
    }

    resultEl.style.color = '#333';
    resultEl.textContent = 'Saving app credentials...';

    try {
      const response = await fetch('/admin/token-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret }),
      });
      const data = await response.json();
      if (response.ok) {
        resultEl.style.color = '#1a7f37';
        resultEl.textContent = 'App credentials saved successfully. Secret is stored but not displayed.';
        const secretInput = document.getElementById('tokenAppSecret');
        if (secretInput) secretInput.value = '********';
      } else {
        resultEl.style.color = '#b30000';
        resultEl.textContent = 'Error saving app credentials: ' + (data.error || 'Unknown');
      }
    } catch (err) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'Request failed: ' + err;
    }
  });
}

restoreSavedFilters();
applyFilters();
`

	return (
		'<!DOCTYPE html>\n' +
		'<html lang="en">\n' +
		'<head>\n' +
		'<meta charset="UTF-8" />\n' +
		'<title>Live Weather Alerts Admin</title>\n' +
		'<style>\n' + css + '\n</style>\n' +
		'</head>\n' +
		'<body>\n' +
		'<h1>Live Weather Alerts Admin</h1>\n' +
		'<p class="subtitle">Active alerts from <a href="https://api.weather.gov/alerts/active" target="_blank">NWS Active Alerts</a>. ' +
    (lastPoll ? 'Last synced: ' + formatLastSynced(lastPoll) + '. ' : '') +
    'Click "Preview &amp; Post" to review and edit before posting.</p>\n' +
    (syncError ? '<p class="sync-error">&#9888; Sync warning: ' + safeHtml(syncError) + '</p>\n' : '') +
		'<div class="admin-page-tabs">\n' +
		'  <button type="button" class="admin-page-tab is-active" data-admin-panel-btn="alerts">Alerts</button>\n' +
		'  <button type="button" class="admin-page-tab" data-admin-panel-btn="facebook-post">Facebook Post</button>\n' +
		'  <button type="button" class="admin-page-tab" data-admin-panel-btn="forecast">Forecast Center</button>\n' +
		'  <button type="button" class="admin-page-tab" data-admin-panel-btn="discussions">NWS Discussions</button>\n' +
		'  <button type="button" class="admin-page-tab" data-admin-panel-btn="outlook">Convective Outlook</button>\n' +
		'</div>\n' +
		'<div class="admin-page-panel is-active" data-admin-panel="alerts">\n' +
		'\n<div class="stats-grid">\n' + statsMarkup + '\n</div>\n' +
		'\n<div class="filter-bar">\n' +
		'  <label>Search: <input id="filterSearch" type="search" placeholder="Search event, area, headline" /></label>\n' +
		'  <label>State: <select id="filterState"><option value="all">All</option>' + stateOptions + '</select></label>\n' +
		'  <label>Severity: <select id="filterSeverity"><option value="all">All</option>' + severityOptions + '</select></label>\n' +
		'  <button type="button" id="clearFilters">Clear</button>\n' +
		'</div>\n' +
		'\n<div class="admin-panel">\n' +
		'  <h2>Facebook Auto Post</h2>\n' +
		'  <p>Choose how automatic Facebook posting should behave. Auto-posted alerts use the same post/comment thread flow as manual posting in admin.</p>\n' +
		'  <label class="toggle-row" for="autoPostMode">\n' +
		'    <span>Auto-post mode</span>\n' +
		'    <select id="autoPostMode">\n' +
		'      <option value="off"' + (normalizedAutoPostConfig.mode === 'off' ? ' selected' : '') + '>Off</option>\n' +
		'      <option value="tornado_only"' + (normalizedAutoPostConfig.mode === 'tornado_only' ? ' selected' : '') + '>Tornado-only</option>\n' +
		'      <option value="smart_high_impact"' + (normalizedAutoPostConfig.mode === 'smart_high_impact' ? ' selected' : '') + '>Smart high-impact</option>\n' +
		'    </select>\n' +
		'  </label>\n' +
		'  <p id="autoPostHelp" class="toggle-help">' + safeHtml(fbAutoPostModeHelp(normalizedAutoPostConfig.mode)) + '</p>\n' +
		'  <div id="autoPostStatus" class="auto-post-status">' + safeHtml(autoPostStatusText) + '</div>\n' +
		'</div>\n' +
		'\n<div class="token-exchange">\n' +
		'  <h2>Convert short-lived user token to long-lived token</h2>\n' +
		'  <p>Enter Facebook App ID, App Secret, and a user access token to generate a long-lived token.</p>\n' +
		'  <label>App ID: <input id="tokenAppId" type="text" value="' + safeHtml(savedAppId) + '" style="width:100%;max-width:480px" /></label>\n' +
		'  <label>App Secret: <input id="tokenAppSecret" type="text" value="' + safeHtml(savedAppSecret) + '" style="width:100%;max-width:480px" /></label>\n' +
		'  <label>User Access Token: <input id="tokenUserToken" type="text" style="width:100%;max-width:480px" /></label>\n' +
		'  <button type="button" id="btnSaveAppConfig">Save app ID/secret</button>\n' +
		'  <button type="button" id="btnTokenExchange">Convert token</button>\n' +
		'  <div id="tokenResult" style="margin-top:10px;color:#333;"></div>\n' +
		'</div>\n' +
		'\n<div class="alerts-list">\n' + cards + '\n</div>\n' +
		'</div>\n' +
		'<div class="admin-page-panel" data-admin-panel="facebook-post">\n' +
		'  <div class="facebook-post-hub">\n' +
		'    <div class="facebook-post-head">\n' +
		'      <div>\n' +
		'        <h2>Facebook Post Ranking</h2>\n' +
		'        <p>Ranked with the smart high-impact Facebook rules from most likely to auto-post down to least likely, with extra weighting for hazard type, audience relevance, pre-warning watch impact, and capped county reach. Priority is a relative ranking number, not a fixed score out of 100 or 1000. Current saved auto-post mode: ' + safeHtml(fbAutoPostModeLabel(normalizedAutoPostConfig.mode)) + '.</p>\n' +
		'      </div>\n' +
		'    </div>\n' +
		'    <div class="stats-grid">\n' + facebookBucketStats + '\n' +
		'    </div>\n' +
		'    <div class="facebook-post-list">\n' + facebookPostCards + '\n' +
		'    </div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'<div class="admin-page-panel" data-admin-panel="forecast">\n' +
		'  <div class="forecast-hub">\n' +
		'    <div class="forecast-hub-head">\n' +
		'      <div>\n' +
		'        <h2>National Forecast Center</h2>\n' +
		'        <p>Regional NWS forecasts for New York City, Atlanta, Chicago, Dallas, and Denver, plus a Facebook-ready 3-day USA summary.</p>\n' +
		'      </div>\n' +
		'      <button type="button" class="forecast-refresh" id="forecastRefreshBtn">Refresh</button>\n' +
		'    </div>\n' +
		'    <div class="forecast-subtabs">\n' + forecastLocationTabs + '\n' +
		'      <button class="forecast-loc-tab" type="button" data-forecast-view="forecast-summary">\n' +
		'        <span class="forecast-loc-label">3-Day USA Summary</span>\n' +
		'        <span class="forecast-loc-region">Facebook-ready national recap</span>\n' +
		'      </button>\n' +
		'    </div>\n' +
		'    <div class="forecast-status" id="forecastHubStatus">Forecast data will load when you open this tab.</div>\n' +
		'    <div id="forecastHubContent"></div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'<div class="admin-page-panel" data-admin-panel="discussions">\n' +
		'  <div class="discussion-hub">\n' +
		'    <div class="forecast-hub-head">\n' +
		'      <div>\n' +
		'        <h2>NWS Discussions</h2>\n' +
		'        <p>Area Forecast Discussions for New York City, Atlanta, Chicago, Dallas, and Denver. Open any discussion to read the full NWS text.</p>\n' +
		'      </div>\n' +
		'      <button type="button" class="forecast-refresh" id="discussionRefreshBtn">Refresh</button>\n' +
		'    </div>\n' +
		'    <div class="forecast-subtabs">\n' + discussionLocationTabs + '\n' +
		'    </div>\n' +
		'    <div class="forecast-status" id="discussionHubStatus">Discussion data will load when you open this tab.</div>\n' +
		'    <div id="discussionHubContent"></div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'<div class="admin-page-panel" data-admin-panel="outlook">\n' +
		'  <div class="forecast-hub">\n' +
		'    <div class="forecast-hub-head">\n' +
		'      <div>\n' +
		'        <h2>Convective Outlook</h2>\n' +
		'        <p>Current SPC Day 1, Day 2, and Day 3 convective outlook images with the full forecast discussion text.</p>\n' +
		'      </div>\n' +
		'      <button type="button" class="forecast-refresh" id="convectiveOutlookRefreshBtn">Refresh</button>\n' +
		'    </div>\n' +
		'    <div class="forecast-subtabs">\n' + convectiveOutlookTabs + '\n' +
		'    </div>\n' +
		'    <div class="forecast-status" id="convectiveOutlookStatus">Convective outlook data will load when you open this tab.</div>\n' +
		'    <div id="convectiveOutlookContent"></div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'\n<div class="modal-overlay" id="fbModal">\n' +
		'  <div class="modal">\n' +
		'    <div class="modal-header">\n' +
		'      <h2>Preview Facebook Post</h2>\n' +
		'      <button class="modal-close" onclick="closeModal()" title="Close">&#x2715;</button>\n' +
		'    </div>\n' +
		'    <div class="modal-body">\n' +
		'      <div id="threadIndicator" class="thread-indicator"></div>\n' +
		'      <div id="fbPreviewImageArea" style="display:none; margin-bottom:12px;">\n' +
		'        <p style="margin:0 0 6px; font-weight:600;">Image preview</p>\n' +
		'        <img id="fbPreviewImage" alt="Alert image preview" style="width:100%; height:260px; object-fit:contain; object-position:center; border:1px solid #ddd; border-radius:6px; background:#111;" />\n' +
		'      </div>\n' +
		'      <label for="fbText">Edit post text before publishing:</label>\n' +
		'      <textarea id="fbText" oninput="updateCharCount()"></textarea>\n' +
		'      <div class="char-count"><span id="charCount">0</span> characters</div>\n' +
		'    </div>\n' +
		'    <div class="modal-footer">\n' +
		'      <div class="post-status" id="postStatus"></div>\n' +
		'      <button class="btn-cancel" onclick="closeModal()">Cancel</button>\n' +
		'      <button class="btn-post" id="btnPost" onclick="submitPost()">Post to Facebook</button>\n' +
		'    </div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'\n<script>\n' + js + '\n</script>\n' +
		'</body>\n</html>'
	);
}

export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	const form = await parseRequestBody(request);
	const password = form.get('password') || '';
	const expected = getAdminPassword(env);
	if (!expected) {
		return new Response(renderLoginPage('Admin access is disabled until ADMIN_PASSWORD is configured.'), {
			status: 503,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}
	if (password !== expected) {
		return new Response(renderLoginPage('Invalid password'), {
			status: 401,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}
	const sessionId = await createAdminSession(env, expected);
	const headers = new Headers({ 'Location': '/admin' });
	headers.set('Cache-Control', 'no-store');
	headers.append('Set-Cookie', buildAdminSessionCookie(request, sessionId));
	return new Response(null, { status: 303, headers });
}

export async function handleAdminPage(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		const adminConfigMessage = getAdminPassword(env)
			? undefined
			: 'Admin access is disabled until ADMIN_PASSWORD is configured.';
		return new Response(renderLoginPage(adminConfigMessage), {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}

	// Sync alerts — uses ETag so it's cheap if nothing changed
	const { map, error } = await syncAlerts(env);
	const alerts = Object.values(map);

	// Surface last poll time in the UI
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const appConfig = await readFbAppConfig(env);
	const autoPostConfig = await readFbAutoPostConfig(env);

	const page = renderAdminPage(
		alerts,
		lastPoll ?? undefined,
		error,
		appConfig,
		autoPostConfig,
	);
	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	return new Response(page, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Thread-check endpoint — called by the modal on open to detect existing threads
// GET /admin/thread-check?alertId=...
// Returns { action: 'new_post' | 'comment', postId?, threadInfo? }
// ---------------------------------------------------------------------------

export async function handleThreadCheck(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const url = new URL(request.url);
	const alertId = url.searchParams.get('alertId') ?? '';

	const map = await readAlertMap(env);
	const feature = Object.values(map).find((a: any) => String(a.id) === alertId) as any;
	if (!feature) {
		return new Response(JSON.stringify({ action: 'new_post' }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const p = feature.properties ?? {};
	const event: string = String(p.event ?? '');

	const thread = await readExistingThreadForFeature(env, feature, event);
	if (thread) {
		return new Response(JSON.stringify({
			action: 'comment',
			postId: thread.postId,
			suggestedCommentText: buildFacebookUpdateCommentMessage(p, thread.lastPostedSnapshot ?? null),
			threadInfo: {
				county: thread.county,
				alertType: thread.alertType,
				postId: thread.postId,
				updateCount: thread.updateCount ?? 0,
			},
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	return new Response(JSON.stringify({ action: 'new_post' }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

export async function handlePost(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const form = await parseRequestBody(request);
	const action = form.get('action');
	const alertId = form.get('alertId') ?? '';
	const customMessage = form.get('customMessage')?.trim() ?? '';
	// threadAction: 'new_post' forces a new post even if a thread exists
	//               'comment'  forces a comment on the existing thread
	//               '' (empty) — auto-detect from KV (default)
	const threadAction = form.get('threadAction')?.trim() ?? '';
	// imageUrl: explicit image URL sent from the admin preview (the same URL
	//           the admin saw in the modal). If present, skip server-side lookup.
	const clientImageUrl = form.get('imageUrl')?.trim() ?? '';

	// Read from KV cache — no live NWS fetch needed here
	let map = await readAlertMap(env);
	let alerts = Object.values(map);

	if (!Array.isArray(alerts) || alerts.length === 0) {
		// If cache is empty, attempt a fresh sync from NWS before posting.
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		alerts = Object.values(map);
	}

	if (!Array.isArray(alerts) || alerts.length === 0) {
		return new Response('No alerts in cache — try reloading the admin page first', { status: 400 });
	}

	let toPost: any[] = [];

	if (action === 'post_alert' && alertId) {
		const match = alerts.find((a: any) => String(a.id) === alertId);
		if (match) toPost = [match];
	}
	if (action === 'auto_post_warning') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'warning');
	}
	if (action === 'auto_post_watch') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'watch');
	}
	if (action === 'auto_post_other') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'other');
	}

	if (toPost.length === 0) {
		return new Response('No matched alerts to post', { status: 400 });
	}

	const results = [];
	for (const feature of toPost.slice(0, 10)) {
		try {
			results.push(await publishFeatureToFacebook(env, feature, {
				request,
				customMessage,
				threadAction,
				imageUrl: clientImageUrl,
			}));
		} catch (err) {
			results.push({ id: feature.id, status: 'error', error: String(err) });
		}
	}

	return new Response(JSON.stringify({ results }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
