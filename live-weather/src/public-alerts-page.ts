type AlertLevel = 'warning' | 'watch' | 'other';

const ALL_STATE_CODES_50 = [
	'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
	'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
	'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
	'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
	'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

export interface PublicPageUtils {
	classifyAlert: (event: string) => AlertLevel;
	severityBadgeColor: (severity: string) => string;
	formatDateTime: (value: string) => string;
	formatAlertDescription: (raw: string) => string;
	formatLastSynced: (iso: string) => string;
	safeHtml: (text: string) => string;
	nl2br: (text: string) => string;
	extractStateCode: (feature: any) => string;
	stateCodeToName: (code: string) => string;
}

function severityRankForSort(severity: string): number {
	const s = String(severity || '').toLowerCase();
	if (s === 'extreme') return 0;
	if (s === 'severe') return 1;
	if (s === 'moderate') return 2;
	if (s === 'minor') return 3;
	return 4;
}

function alertLevelInfo(level: AlertLevel): { label: string; helper: string } {
	if (level === 'warning') {
		return {
			label: 'Take Action Now',
			helper: 'Danger is happening or very close.',
		};
	}
	if (level === 'watch') {
		return {
			label: 'Be Ready',
			helper: 'Danger is possible. Prepare now.',
		};
	}
	return {
		label: 'Stay Aware',
		helper: 'Keep checking updates and stay careful.',
	};
}

function summarizeAreaForCard(areaDesc: string, maxItems = 6): string {
	const text = String(areaDesc || '').trim();
	if (!text) return 'Unknown area';
	const parts = text
		.split(/\s*;\s*|\s*,\s*/)
		.map((v) => v.trim())
		.filter(Boolean);
	if (parts.length <= maxItems) return parts.join(', ');
	const remaining = parts.length - maxItems;
	return parts.slice(0, maxItems).join(', ') + `, and ${remaining} more`;
}

function simplifyMeaning(event: string): string {
	const e = String(event || '').toLowerCase();
	if (e.includes('tornado')) {
		return 'A tornado may happen soon, or may already be happening nearby.';
	}
	if (e.includes('severe thunderstorm')) {
		return 'A strong storm can bring dangerous wind and hail.';
	}
	if (e.includes('flash flood') || e.includes('flood')) {
		return 'Water can rise fast and make roads unsafe.';
	}
	if (e.includes('winter') || e.includes('blizzard') || e.includes('ice') || e.includes('snow') || e.includes('freez')) {
		return 'Snow or ice can make travel slippery and dangerous.';
	}
	if (e.includes('hurricane') || e.includes('tropical storm') || e.includes('storm surge')) {
		return 'Strong tropical weather can cause floods, wind damage, and power loss.';
	}
	if (e.includes('heat')) {
		return 'Very hot weather can make people sick quickly.';
	}
	if (e.includes('wind chill') || e.includes('cold') || e.includes('freeze')) {
		return 'Dangerous cold can hurt skin and make people sick quickly.';
	}
	if (e.includes('air quality') || e.includes('smoke')) {
		return 'Smoke or dirty air can make breathing harder.';
	}
	if (e.includes('fog')) {
		return 'Low visibility can make driving unsafe.';
	}
	return 'Weather may become dangerous in this area.';
}

function quickStepsForEvent(event: string): string[] {
	const e = String(event || '').toLowerCase();
	if (e.includes('tornado')) {
		return [
			'Go to a small room inside on the lowest floor.',
			'Stay away from windows and outside walls.',
			'Cover your head and neck until danger passes.',
		];
	}
	if (e.includes('flash flood') || e.includes('flood')) {
		return [
			'Move to higher ground now.',
			'Never drive through flooded roads.',
			'Keep children and pets away from fast water.',
		];
	}
	if (e.includes('severe thunderstorm')) {
		return [
			'Go indoors and stay away from windows.',
			'Bring in loose outdoor items.',
			'Charge phones and keep a flashlight nearby.',
		];
	}
	if (e.includes('winter') || e.includes('blizzard') || e.includes('ice') || e.includes('snow') || e.includes('freez')) {
		return [
			'Avoid travel if possible until roads improve.',
			'Wear warm layers and cover your hands and face.',
			'Keep a blanket, food, and charged phone nearby.',
		];
	}
	if (e.includes('hurricane') || e.includes('tropical storm') || e.includes('storm surge')) {
		return [
			'Get your emergency bag ready now.',
			'Stay away from flood-prone roads and coastlines.',
			'Follow local evacuation orders right away.',
		];
	}
	if (e.includes('heat')) {
		return [
			'Drink water often and stay in a cool place.',
			'Check on older adults, kids, and pets.',
			'Avoid hard outdoor work during peak heat.',
		];
	}
	if (e.includes('wind chill') || e.includes('cold') || e.includes('freeze')) {
		return [
			'Wear layers and cover all exposed skin.',
			'Limit time outside, especially for children.',
			'Bring pets inside and protect pipes.',
		];
	}
	if (e.includes('air quality') || e.includes('smoke')) {
		return [
			'Stay indoors with windows closed.',
			'Limit outdoor activity and exercise.',
			'Use clean indoor air if available.',
		];
	}
	if (e.includes('fog')) {
		return [
			'Drive slowly with low-beam headlights.',
			'Leave extra distance between cars.',
			'Delay travel if visibility is very low.',
		];
	}
	return [
		'Keep phone weather alerts turned on.',
		'Know the safest indoor place for your family.',
		'Check on neighbors who may need help.',
	];
}

function timeUntilExpires(isoValue: string): string {
	const ms = new Date(isoValue).getTime();
	if (Number.isNaN(ms)) return 'Unknown';
	const delta = ms - Date.now();
	if (delta <= 0) return 'Expired or ending now';
	const totalMinutes = Math.round(delta / 60000);
	if (totalMinutes < 60) {
		return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'} left`;
	}
	const totalHours = Math.floor(totalMinutes / 60);
	const remMinutes = totalMinutes % 60;
	if (totalHours < 24) {
		if (remMinutes === 0) return `${totalHours} hour${totalHours === 1 ? '' : 's'} left`;
		return `${totalHours}h ${remMinutes}m left`;
	}
	const days = Math.floor(totalHours / 24);
	const remHours = totalHours % 24;
	if (remHours === 0) return `${days} day${days === 1 ? '' : 's'} left`;
	return `${days}d ${remHours}h left`;
}

function toTitleCase(value: string): string {
	return String(value || '')
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}

function formatStateDisplayName(raw: string): string {
	const cleaned = String(raw || '').replace(/-/g, ' ').trim();
	if (!cleaned) return '';
	return toTitleCase(cleaned);
}

export function renderPublicAlertsPage(
	alerts: any[],
	lastPoll: string | undefined,
	syncError: string | undefined,
	utils: PublicPageUtils,
): string {
	const {
		classifyAlert,
		severityBadgeColor,
		formatDateTime,
		formatAlertDescription,
		formatLastSynced,
		safeHtml,
		nl2br,
		extractStateCode,
		stateCodeToName,
	} = utils;

	const sortedAlerts = [...alerts].sort((a, b) => {
		const ap = a?.properties ?? {};
		const bp = b?.properties ?? {};
		const aLevel = classifyAlert(String(ap.event ?? ''));
		const bLevel = classifyAlert(String(bp.event ?? ''));
		const levelRank = (level: AlertLevel) => level === 'warning' ? 0 : level === 'watch' ? 1 : 2;
		const aLevelRank = levelRank(aLevel);
		const bLevelRank = levelRank(bLevel);
		if (aLevelRank !== bLevelRank) return aLevelRank - bLevelRank;

		const aSeverity = severityRankForSort(String(ap.severity ?? ''));
		const bSeverity = severityRankForSort(String(bp.severity ?? ''));
		if (aSeverity !== bSeverity) return aSeverity - bSeverity;

		const aExpiresRaw = ap.expires ? new Date(ap.expires).getTime() : Number.POSITIVE_INFINITY;
		const bExpiresRaw = bp.expires ? new Date(bp.expires).getTime() : Number.POSITIVE_INFINITY;
		const aExpires = Number.isNaN(aExpiresRaw) ? Number.POSITIVE_INFINITY : aExpiresRaw;
		const bExpires = Number.isNaN(bExpiresRaw) ? Number.POSITIVE_INFINITY : bExpiresRaw;
		return aExpires - bExpires;
	});

	const warningCount = sortedAlerts.filter((feature) => classifyAlert(String(feature?.properties?.event ?? '')) === 'warning').length;
	const watchCount = sortedAlerts.filter((feature) => classifyAlert(String(feature?.properties?.event ?? '')) === 'watch').length;
	const otherCount = sortedAlerts.length - warningCount - watchCount;
	const hasAlerts = sortedAlerts.length > 0;
	const lastSyncedText = lastPoll ? formatLastSynced(lastPoll) : 'Waiting for first sync';

	// Always include all 50 states in the dropdown. If alerts contain additional
	// valid codes (for example DC), include those too so filtering still works.
	const stateCodeSet = new Set<string>(ALL_STATE_CODES_50);
	for (const feature of sortedAlerts) {
		const code = String(extractStateCode(feature) || '').toUpperCase();
		if (code) stateCodeSet.add(code);
	}
	const statesForFilter = Array.from(stateCodeSet).sort((a, b) => {
		const aName = formatStateDisplayName(stateCodeToName(a) || a);
		const bName = formatStateDisplayName(stateCodeToName(b) || b);
		return aName.localeCompare(bName);
	});

	const stateOptions = statesForFilter
		.map((code) => {
			const name = formatStateDisplayName(stateCodeToName(code) || code);
			return '<option value="' + safeHtml(code) + '">' + safeHtml(name) + '</option>';
		})
		.join('');

	const cards = sortedAlerts.map((feature, idx) => {
		const p = feature?.properties ?? {};
		const event = String(p.event ?? 'Weather Alert');
		const severity = String(p.severity ?? 'Unknown');
		const headline = String(p.headline ?? '').trim();
		const areaDesc = String(p.areaDesc ?? 'Unknown area');
		const stateCode = String(extractStateCode(feature) || '').toUpperCase();
		const stateName = stateCode
			? formatStateDisplayName(stateCodeToName(stateCode) || stateCode)
			: '';
		const summaryArea = summarizeAreaForCard(areaDesc);
		const level = classifyAlert(event);
		const levelInfo = alertLevelInfo(level);
		const sent = p.sent ? formatDateTime(p.sent) : (p.effective ? formatDateTime(p.effective) : 'Unknown');
		const expires = p.expires ? formatDateTime(p.expires) : 'Unknown';
		const expiresCountdown = p.expires ? timeUntilExpires(String(p.expires)) : 'Unknown';
		const description = formatAlertDescription(String(p.description ?? ''));
		const instruction = formatAlertDescription(String(p.instruction ?? ''));
		const meaning = simplifyMeaning(event);
		const steps = quickStepsForEvent(event);
		const stepItems = steps.map((step) => '<li>' + safeHtml(step) + '</li>').join('');
		const searchText = (
			event + ' ' +
			areaDesc + ' ' +
			headline + ' ' +
			description + ' ' +
			instruction + ' ' +
			stateName + ' ' +
			stateCode
		).toLowerCase();
		const nwsId = String(p['@id'] ?? feature?.id ?? '');
		const nwsLink = /^https?:\/\//i.test(nwsId)
			? '<a class="nws-link" href="' + safeHtml(nwsId) + '" target="_blank" rel="noopener noreferrer">View official NWS alert</a>'
			: '';
		const delay = Math.min(idx * 0.05, 0.7).toFixed(2);
		const headlineHtml = headline ? '<p class="headline">' + safeHtml(headline) + '</p>' : '';
		const descriptionHtml = description
			? '<p class="detail-copy">' + nl2br(description) + '</p>'
			: '<p class="detail-copy muted">No extra details were provided.</p>';
		const instructionHtml = instruction
			? '<p class="detail-copy">' + nl2br(instruction) + '</p>'
			: '<p class="detail-copy muted">No special actions were provided.</p>';
		const stateHtml = stateName
			? '<span class="state-chip">' + safeHtml(stateName) + '</span>'
			: '';

		return (
			'<article class="alert-card level-' + level + '" data-level="' + level + '" data-state="' + safeHtml(stateCode) + '" data-search="' + safeHtml(searchText) + '" style="animation-delay:' + delay + 's">\n' +
			'  <div class="card-top">\n' +
			'    <div class="pill-row">\n' +
			'      <span class="level-pill level-' + level + '">' + safeHtml(levelInfo.label) + '</span>\n' +
			'      <span class="severity-pill" style="background:' + severityBadgeColor(severity) + '">' + safeHtml(severity.toUpperCase()) + '</span>\n' +
			'      ' + stateHtml + '\n' +
			'    </div>\n' +
			'    <h2>' + safeHtml(event) + '</h2>\n' +
			'    <p class="area-line">' + safeHtml(summaryArea) + '</p>\n' +
			headlineHtml + '\n' +
			'  </div>\n' +
			'  <div class="plain-meaning">\n' +
			'    <h3>What this means</h3>\n' +
			'    <p>' + safeHtml(meaning) + '</p>\n' +
			'    <p class="helper">' + safeHtml(levelInfo.helper) + '</p>\n' +
			'  </div>\n' +
			'  <div class="quick-steps">\n' +
			'    <h3>What to do now</h3>\n' +
			'    <ul>' + stepItems + '</ul>\n' +
			'  </div>\n' +
			'  <div class="time-grid">\n' +
			'    <p><span>Issued</span><strong>' + safeHtml(sent) + '</strong></p>\n' +
			'    <p><span>Expires</span><strong>' + safeHtml(expires) + '</strong></p>\n' +
			'    <p><span>Time left</span><strong>' + safeHtml(expiresCountdown) + '</strong></p>\n' +
			'  </div>\n' +
			'  <details class="details-block">\n' +
			'    <summary>Read full details</summary>\n' +
			'    <div class="details-content">\n' +
			'      <p class="detail-label">Affected Areas</p>\n' +
			'      <p class="detail-copy">' + safeHtml(areaDesc) + '</p>\n' +
			'      <p class="detail-label">Description</p>\n' +
			'      ' + descriptionHtml + '\n' +
			'      <p class="detail-label">Instructions</p>\n' +
			'      ' + instructionHtml + '\n' +
			'      ' + nwsLink + '\n' +
			'    </div>\n' +
			'  </details>\n' +
			'</article>'
		);
	}).join('\n');

	const css = [
		':root {',
		'  --sky-0: #f8fbff;',
		'  --sky-1: #dff1ff;',
		'  --sky-2: #c7e8ff;',
		'  --ink: #10263b;',
		'  --muted: #3d4e5f;',
		'  --card: #ffffff;',
		'  --warning: #b5271f;',
		'  --watch: #c96a11;',
		'  --other: #1f6ea0;',
		'}',
		'*, *::before, *::after { box-sizing: border-box; }',
		'html, body { margin: 0; padding: 0; }',
		'body {',
		'  min-height: 100vh;',
		'  font-family: "Nunito", "Segoe UI", sans-serif;',
		'  color: var(--ink);',
		'  background:',
		'    radial-gradient(circle at 8% 12%, rgba(255,255,255,0.95) 0, rgba(255,255,255,0) 38%),',
		'    radial-gradient(circle at 92% 2%, rgba(255,230,192,0.75) 0, rgba(255,230,192,0) 35%),',
		'    linear-gradient(160deg, var(--sky-0) 0%, var(--sky-1) 48%, var(--sky-2) 100%);',
		'}',
		'.page { width: min(1140px, 100% - 28px); margin: 22px auto 34px; }',
		'.hero {',
		'  background: linear-gradient(145deg, rgba(255,255,255,0.92) 0%, rgba(255,246,228,0.95) 100%);',
		'  border: 1px solid rgba(16,38,59,0.12);',
		'  border-radius: 22px;',
		'  padding: 24px 22px 20px;',
		'  box-shadow: 0 20px 44px rgba(18, 52, 84, 0.14);',
		'  animation: hero-in 400ms ease-out both;',
		'}',
		'.hero h1 { margin: 10px 0 8px; font-family: "Fredoka", "Trebuchet MS", sans-serif; font-weight: 700; font-size: clamp(1.8rem, 3vw, 2.35rem); line-height: 1.12; }',
		'.hero p { margin: 0; color: var(--muted); font-size: clamp(1rem, 2vw, 1.09rem); max-width: 70ch; }',
		'.hero-meta { margin-top: 15px; display: flex; flex-wrap: wrap; gap: 10px; }',
		'.meta-pill { background: rgba(255,255,255,0.9); border: 1px solid rgba(16,38,59,0.15); border-radius: 999px; padding: 8px 12px; font-size: 0.94rem; font-weight: 700; }',
		'.sync-warning { margin-top: 12px; background: #fff5cf; border: 1px solid #f0cf67; color: #6a4f00; border-radius: 10px; padding: 8px 12px; font-weight: 700; }',
		'.summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }',
		'.summary-card { background: rgba(255,255,255,0.92); border: 1px solid rgba(16,38,59,0.12); border-radius: 14px; padding: 12px; }',
		'.summary-card strong { display: block; font-size: 1.55rem; margin-top: 3px; }',
		'.summary-card.warning strong { color: var(--warning); }',
		'.summary-card.watch strong { color: var(--watch); }',
		'.summary-card.other strong { color: var(--other); }',
		'.summary-card small { color: var(--muted); font-weight: 700; }',
		'.controls { margin-top: 16px; background: rgba(255,255,255,0.94); border: 1px solid rgba(16,38,59,0.12); border-radius: 16px; padding: 12px; display: grid; grid-template-columns: minmax(220px, 1fr) 220px 220px auto; gap: 10px; align-items: end; }',
		'.controls label { display: flex; flex-direction: column; gap: 6px; font-weight: 800; font-size: 0.9rem; color: #17324a; }',
		'.controls input, .controls select { border: 1px solid #b4c8da; border-radius: 10px; padding: 10px 12px; font-size: 1rem; font-family: inherit; background: #fff; }',
		'.controls button { border: 1px solid #2b618a; background: #2b618a; color: #fff; border-radius: 10px; padding: 10px 14px; font-weight: 800; cursor: pointer; min-height: 44px; }',
		'.controls button:hover { background: #234f72; }',
		'.quick-filters { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }',
		'.chip-btn { border: 1px solid #9fb8cc; background: rgba(255,255,255,0.9); color: #11314c; border-radius: 999px; padding: 8px 12px; font-weight: 800; cursor: pointer; font-size: 0.92rem; }',
		'.chip-btn.active { background: #11314c; color: #fff; border-color: #11314c; }',
		'.results-row { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }',
		'.results-row p { margin: 0; color: #123450; font-weight: 800; font-size: 1rem; }',
		'.refresh-btn { border: 1px solid #3978a6; background: rgba(255,255,255,0.9); color: #104267; border-radius: 10px; padding: 8px 12px; font-weight: 800; cursor: pointer; }',
		'.refresh-btn:hover { background: #f0f8ff; }',
		'.alerts-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }',
		'.alert-card { background: var(--card); border: 1px solid rgba(15,47,74,0.14); border-radius: 16px; box-shadow: 0 8px 22px rgba(16,38,59,0.1); overflow: hidden; opacity: 0; transform: translateY(12px); animation: card-in 380ms ease-out forwards; }',
		'.alert-card.level-warning { border-top: 6px solid var(--warning); }',
		'.alert-card.level-watch { border-top: 6px solid var(--watch); }',
		'.alert-card.level-other { border-top: 6px solid var(--other); }',
		'.card-top { padding: 14px 14px 10px; }',
		'.pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }',
		'.level-pill, .severity-pill, .state-chip { font-size: 0.76rem; letter-spacing: 0.03em; font-weight: 900; border-radius: 999px; padding: 4px 9px; color: #fff; }',
		'.level-pill, .severity-pill { text-transform: uppercase; }',
		'.level-pill.level-warning { background: var(--warning); }',
		'.level-pill.level-watch { background: var(--watch); }',
		'.level-pill.level-other { background: var(--other); }',
		'.severity-pill { box-shadow: inset 0 -1px 0 rgba(255,255,255,0.3); }',
		'.state-chip { background: #103f69; text-transform: none; }',
		'.card-top h2 { margin: 0; font-family: "Fredoka", "Trebuchet MS", sans-serif; font-size: clamp(1.25rem, 2vw, 1.48rem); line-height: 1.15; }',
		'.area-line { margin: 8px 0 0; color: #1f425f; font-weight: 800; font-size: 1rem; }',
		'.headline { margin: 9px 0 0; background: #eef7ff; border: 1px solid #d5e8f7; border-radius: 10px; padding: 8px 10px; font-weight: 700; color: #17354d; }',
		'.plain-meaning, .quick-steps { margin: 0 14px 10px; border: 1px solid #dce8f3; border-radius: 12px; padding: 10px 11px; background: #fafdff; }',
		'.plain-meaning h3, .quick-steps h3 { margin: 0 0 7px; font-size: 0.96rem; letter-spacing: 0.01em; font-weight: 900; color: #11314c; }',
		'.plain-meaning p { margin: 0; font-size: 1rem; line-height: 1.45; }',
		'.plain-meaning .helper { margin-top: 7px; color: #33536e; font-weight: 700; }',
		'.quick-steps ul { margin: 0; padding-left: 20px; font-size: 0.98rem; }',
		'.quick-steps li { margin-bottom: 5px; line-height: 1.35; }',
		'.time-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid #e5edf5; border-bottom: 1px solid #e5edf5; }',
		'.time-grid p { margin: 0; padding: 10px 9px; border-right: 1px solid #e5edf5; display: flex; flex-direction: column; gap: 4px; }',
		'.time-grid p:last-child { border-right: 0; }',
		'.time-grid span { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; color: #4a6780; font-weight: 800; }',
		'.time-grid strong { font-size: 0.88rem; color: #14324b; line-height: 1.3; }',
		'.details-block summary { list-style: none; cursor: pointer; padding: 11px 14px; font-weight: 900; color: #0f4165; user-select: none; }',
		'.details-block summary::-webkit-details-marker { display: none; }',
		'.details-block summary:hover { background: #f3f9ff; }',
		'.details-content { padding: 0 14px 13px; }',
		'.detail-label { margin: 8px 0 5px; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.03em; color: #4a6780; font-weight: 900; }',
		'.detail-copy { margin: 0; line-height: 1.45; white-space: normal; color: #1f3f5a; }',
		'.detail-copy.muted { color: #5f7385; font-style: italic; }',
		'.nws-link { display: inline-block; margin-top: 11px; font-weight: 900; color: #0f4f78; text-decoration-thickness: 2px; }',
		'.nws-link:hover { color: #0c3e5f; }',
		'.empty-state { margin-top: 12px; background: rgba(255,255,255,0.96); border: 1px solid rgba(16,38,59,0.14); border-radius: 16px; padding: 20px; text-align: center; }',
		'.empty-state h2 { margin: 0 0 6px; font-family: "Fredoka", "Trebuchet MS", sans-serif; }',
		'.empty-state p { margin: 0; color: #42586d; font-size: 1rem; }',
		'.filter-empty { margin-top: 12px; background: #fff; border: 1px dashed #9db7ca; border-radius: 14px; padding: 18px; color: #264960; display: none; text-align: center; font-weight: 700; }',
		'.footer-note { margin-top: 18px; color: #21425f; font-size: 0.95rem; text-align: center; }',
		'@keyframes hero-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }',
		'@keyframes card-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }',
		'@media (max-width: 1200px) {',
		'  .controls { grid-template-columns: 1fr 1fr; }',
		'}',
		'@media (max-width: 980px) {',
		'  .alerts-grid { grid-template-columns: 1fr; }',
		'  .controls { grid-template-columns: 1fr; }',
		'}',
		'@media (max-width: 680px) {',
		'  .page { width: min(100% - 18px, 1140px); margin-top: 14px; }',
		'  .hero { border-radius: 16px; padding: 18px 16px; }',
		'  .summary-grid { grid-template-columns: 1fr; }',
		'  .time-grid { grid-template-columns: 1fr; }',
		'  .time-grid p { border-right: 0; border-bottom: 1px solid #e5edf5; }',
		'  .time-grid p:last-child { border-bottom: 0; }',
		'}',
	].join('\n');

	const js = `
const STATE_STORAGE_KEY = 'liveWeather:selectedState';
const cards = Array.from(document.querySelectorAll('.alert-card'));
const searchInput = document.getElementById('searchInput');
const levelFilter = document.getElementById('levelFilter');
const stateFilter = document.getElementById('stateFilter');
const resultsCount = document.getElementById('resultsCount');
const filterEmpty = document.getElementById('filterEmptyState');
const chipButtons = Array.from(document.querySelectorAll('.chip-btn'));

function updateQuickButtons(level) {
	chipButtons.forEach((btn) => {
		const btnLevel = btn.getAttribute('data-level') || 'all';
		btn.classList.toggle('active', btnLevel === level);
	});
}

function hasStateOption(value) {
	if (!stateFilter || !value) return false;
	return Array.from(stateFilter.options).some((option) => option.value === value);
}

function loadSavedState() {
	try {
		const stored = localStorage.getItem(STATE_STORAGE_KEY) || '';
		return hasStateOption(stored) ? stored : 'all';
	} catch {
		return 'all';
	}
}

function saveState(value) {
	try {
		localStorage.setItem(STATE_STORAGE_KEY, value || 'all');
	} catch {
		// ignore storage errors (private mode, policy restrictions, etc.)
	}
}

function applyFilters() {
	const needle = String(searchInput?.value || '').trim().toLowerCase();
	const level = String(levelFilter?.value || 'all');
	const state = String(stateFilter?.value || 'all');
	let visibleCount = 0;
	cards.forEach((card) => {
		const cardLevel = card.getAttribute('data-level') || 'other';
		const cardState = card.getAttribute('data-state') || '';
		const haystack = card.getAttribute('data-search') || '';
		const levelMatch = level === 'all' || cardLevel === level;
		const stateMatch = state === 'all' || cardState === state;
		const searchMatch = needle === '' || haystack.includes(needle);
		const visible = levelMatch && stateMatch && searchMatch;
		card.style.display = visible ? '' : 'none';
		if (visible) visibleCount += 1;
	});
	if (resultsCount) {
		const word = visibleCount === 1 ? 'alert' : 'alerts';
		resultsCount.textContent = 'Showing ' + visibleCount + ' ' + word;
	}
	if (filterEmpty) {
		filterEmpty.style.display = visibleCount === 0 ? 'block' : 'none';
	}
}

chipButtons.forEach((btn) => {
	btn.addEventListener('click', () => {
		const level = btn.getAttribute('data-level') || 'all';
		if (levelFilter) levelFilter.value = level;
		updateQuickButtons(level);
		applyFilters();
	});
});

if (searchInput) {
	searchInput.addEventListener('input', () => {
		updateQuickButtons(String(levelFilter?.value || 'all'));
		applyFilters();
	});
}

if (levelFilter) {
	levelFilter.addEventListener('change', () => {
		const value = String(levelFilter.value || 'all');
		updateQuickButtons(value);
		applyFilters();
	});
}

if (stateFilter) {
	stateFilter.value = loadSavedState();
	stateFilter.addEventListener('change', () => {
		const value = String(stateFilter.value || 'all');
		saveState(value);
		applyFilters();
	});
}

const clearButton = document.getElementById('clearFilters');
if (clearButton) {
	clearButton.addEventListener('click', () => {
		if (searchInput) searchInput.value = '';
		if (levelFilter) levelFilter.value = 'all';
		updateQuickButtons('all');
		applyFilters();
		searchInput?.focus();
	});
}

const refreshButton = document.getElementById('refreshPage');
if (refreshButton) {
	refreshButton.addEventListener('click', () => {
		window.location.reload();
	});
}

updateQuickButtons(String(levelFilter?.value || 'all'));
applyFilters();
`;

	return (
		'<!DOCTYPE html>\n' +
		'<html lang="en">\n' +
		'<head>\n' +
		'  <meta charset="UTF-8" />\n' +
		'  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
		'  <title>Live Weather Alerts</title>\n' +
		'  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
		'  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
		'  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />\n' +
		'  <style>\n' + css + '\n  </style>\n' +
		'</head>\n' +
		'<body>\n' +
		'  <main class="page">\n' +
		'    <section class="hero">\n' +
		'      <h1>Live Weather Alerts</h1>\n' +
		'      <p>Simple, clear safety updates from the National Weather Service. The most urgent alerts are listed first.</p>\n' +
		'      <div class="hero-meta">\n' +
		'        <span class="meta-pill">Active alerts: <strong>' + safeHtml(String(sortedAlerts.length)) + '</strong></span>\n' +
		'        <span class="meta-pill">Last synced: <strong>' + safeHtml(lastSyncedText) + '</strong></span>\n' +
		'      </div>\n' +
		(syncError ? '      <p class="sync-warning">Sync warning: ' + safeHtml(syncError) + '</p>\n' : '') +
		'      <div class="summary-grid">\n' +
		'        <div class="summary-card warning"><small>Warnings</small><strong>' + safeHtml(String(warningCount)) + '</strong><small>Take action now</small></div>\n' +
		'        <div class="summary-card watch"><small>Watches</small><strong>' + safeHtml(String(watchCount)) + '</strong><small>Be ready</small></div>\n' +
		'        <div class="summary-card other"><small>Other alerts</small><strong>' + safeHtml(String(otherCount)) + '</strong><small>Stay aware</small></div>\n' +
		'      </div>\n' +
		'      <div class="controls">\n' +
		'        <label>Search by place or alert type\n' +
		'          <input id="searchInput" type="search" placeholder="Example: flood, tornado, Pike County" />\n' +
		'        </label>\n' +
		'        <label>Show alert level\n' +
		'          <select id="levelFilter">\n' +
		'            <option value="all">All levels</option>\n' +
		'            <option value="warning">Take action now</option>\n' +
		'            <option value="watch">Be ready</option>\n' +
		'            <option value="other">Stay aware</option>\n' +
		'          </select>\n' +
		'        </label>\n' +
		'        <label>Choose state\n' +
		'          <select id="stateFilter">\n' +
		'            <option value="all">All states</option>\n' +
		stateOptions + '\n' +
		'          </select>\n' +
		'        </label>\n' +
		'        <button type="button" id="clearFilters">Clear filters</button>\n' +
		'      </div>\n' +
		'      <div class="quick-filters">\n' +
		'        <button type="button" class="chip-btn active" data-level="all">Show all</button>\n' +
		'        <button type="button" class="chip-btn" data-level="warning">Action now</button>\n' +
		'        <button type="button" class="chip-btn" data-level="watch">Be ready</button>\n' +
		'        <button type="button" class="chip-btn" data-level="other">Stay aware</button>\n' +
		'      </div>\n' +
		'    </section>\n' +
		'    <section class="results-row" aria-live="polite">\n' +
		'      <p id="resultsCount">' + (hasAlerts ? 'Showing ' + sortedAlerts.length + ' alerts' : 'No active alerts right now') + '</p>\n' +
		'      <button type="button" class="refresh-btn" id="refreshPage">Refresh now</button>\n' +
		'    </section>\n' +
		(hasAlerts
			? '    <section class="alerts-grid">\n' + cards + '\n    </section>\n'
			: '    <section class="empty-state"><h2>No active weather alerts</h2><p>Check back soon. This page updates regularly with the latest NWS alerts.</p></section>\n'
		) +
		'    <section class="filter-empty" id="filterEmptyState">No alerts match your current filter. Try a different search term.</section>\n' +
		'    <p class="footer-note">Source: <a href="https://api.weather.gov/alerts/active" target="_blank" rel="noopener noreferrer">NWS Active Alerts Feed</a></p>\n' +
		'  </main>\n' +
		'  <script>\n' + js + '\n  </script>\n' +
		'</body>\n' +
		'</html>'
	);
}
