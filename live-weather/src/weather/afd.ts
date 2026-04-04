import type {
	SpcAfdEnrichment,
	SpcAfdOfficeSelection,
	SpcAfdSignal,
	SpcOutlookSummary,
} from '../types';
import { dedupeStrings, stateCodeDisplayName } from '../utils';
import { fetchNwsProductById, fetchNwsProductList } from './api';

type AfdOfficeProfile = {
	code: string;
	label: string;
	primaryRegion: string;
	states: string[];
	focusKeywords?: string[];
};

type AfdHintPattern = {
	pattern: RegExp;
	value: string;
};

const MAX_AFD_OFFICES = 4;
const MAX_HINTS_PER_BUCKET = 3;
const AFD_PRODUCT_LOOKBACK = 3;

const office = (
	code: string,
	label: string,
	primaryRegion: string,
	states: string[],
	focusKeywords: string[] = [],
): AfdOfficeProfile => ({
	code,
	label,
	primaryRegion,
	states,
	focusKeywords,
});

const STATE_AFD_OFFICES: Record<string, AfdOfficeProfile[]> = {
	AL: [office('BMX', 'Birmingham AL', 'Southeast', ['AL'], ['central alabama', 'birmingham', 'middle alabama']), office('HUN', 'Huntsville AL', 'Southeast', ['AL', 'TN'], ['north alabama', 'tennessee valley']), office('MOB', 'Mobile AL', 'Gulf Coast', ['AL', 'FL'], ['south alabama', 'mobile'])],
	AK: [office('AFC', 'Anchorage AK', 'West', ['AK'])],
	AZ: [office('PSR', 'Phoenix AZ', 'Southwest', ['AZ'], ['central arizona', 'phoenix']), office('TWC', 'Tucson AZ', 'Southwest', ['AZ'], ['southern arizona', 'tucson'])],
	AR: [office('LZK', 'Little Rock AR', 'Mid-South', ['AR'], ['central arkansas', 'little rock'])],
	CA: [office('STO', 'Sacramento CA', 'West', ['CA'], ['northern california', 'sacramento']), office('HNX', 'Hanford CA', 'West', ['CA'], ['central california', 'san joaquin valley']), office('LOX', 'Los Angeles/Oxnard CA', 'West', ['CA'], ['southern california', 'los angeles'])],
	CO: [office('BOU', 'Boulder CO', 'West', ['CO'], ['northeast colorado', 'front range', 'denver']), office('PUB', 'Pueblo CO', 'West', ['CO'], ['southeast colorado', 'pueblo']), office('GLD', 'Goodland KS', 'Plains', ['CO', 'KS', 'NE'], ['eastern colorado'])],
	CT: [office('BOX', 'Boston/Norton MA', 'Northeast', ['CT', 'MA', 'RI'], ['connecticut', 'southern new england']), office('OKX', 'New York NY', 'Northeast', ['CT', 'NY', 'NJ'], ['southwest connecticut'])],
	DC: [office('LWX', 'Baltimore/Washington DC', 'Northeast', ['DC', 'MD', 'VA', 'WV'])],
	DE: [office('PHI', 'Mount Holly NJ', 'Northeast', ['DE', 'NJ', 'PA'], ['delaware'])],
	FL: [office('JAX', 'Jacksonville FL', 'Southeast', ['FL', 'GA'], ['north florida', 'jacksonville']), office('TBW', 'Tampa Bay FL', 'Gulf Coast', ['FL'], ['west central florida', 'tampa']), office('TAE', 'Tallahassee FL', 'Gulf Coast', ['FL', 'GA', 'AL'], ['panhandle', 'northwest florida']), office('MFL', 'Miami FL', 'Southeast', ['FL'], ['south florida', 'miami'])],
	GA: [office('FFC', 'Peachtree City GA', 'Southeast', ['GA'], ['georgia', 'atlanta'])],
	HI: [office('HFO', 'Honolulu HI', 'West', ['HI'])],
	IA: [office('DMX', 'Des Moines IA', 'Midwest', ['IA'], ['central iowa', 'southern iowa', 'des moines']), office('DVN', 'Quad Cities IA/IL', 'Midwest', ['IA', 'IL'], ['eastern iowa', 'quad cities']), office('FSD', 'Sioux Falls SD', 'Plains', ['IA', 'SD', 'MN'], ['northwest iowa', 'western iowa'])],
	ID: [office('BOI', 'Boise ID', 'West', ['ID'], ['southwest idaho', 'boise']), office('PIH', 'Pocatello ID', 'West', ['ID'], ['southeast idaho'])],
	IL: [office('LOT', 'Chicago/Romeoville IL', 'Great Lakes', ['IL'], ['northern illinois', 'chicago']), office('ILX', 'Lincoln IL', 'Midwest', ['IL'], ['central illinois']), office('LSX', 'St. Louis MO', 'Midwest', ['IL', 'MO'], ['southwest illinois', 'st louis metro']), office('PAH', 'Paducah KY', 'Ohio Valley', ['IL', 'KY', 'MO'], ['southern illinois'])],
	IN: [office('IND', 'Indianapolis IN', 'Ohio Valley', ['IN'], ['central indiana', 'indianapolis']), office('IWX', 'Northern Indiana', 'Great Lakes', ['IN', 'MI', 'OH'], ['northern indiana'])],
	KS: [office('TOP', 'Topeka KS', 'Central Plains', ['KS'], ['eastern kansas', 'northeast kansas']), office('ICT', 'Wichita KS', 'Southern Plains', ['KS'], ['south central kansas', 'wichita']), office('DDC', 'Dodge City KS', 'Plains', ['KS'], ['western kansas'])],
	KY: [office('LMK', 'Louisville KY', 'Ohio Valley', ['KY'], ['central kentucky', 'louisville']), office('JKL', 'Jackson KY', 'Southeast', ['KY'], ['eastern kentucky']), office('PAH', 'Paducah KY', 'Ohio Valley', ['KY', 'IL', 'MO'], ['western kentucky'])],
	LA: [office('SHV', 'Shreveport LA', 'Gulf Coast', ['LA', 'TX', 'AR'], ['north louisiana', 'shreveport']), office('LIX', 'New Orleans LA', 'Gulf Coast', ['LA', 'MS'], ['southeast louisiana', 'new orleans']), office('LCH', 'Lake Charles LA', 'Gulf Coast', ['LA', 'TX'], ['southwest louisiana'])],
	MA: [office('BOX', 'Boston/Norton MA', 'Northeast', ['MA', 'RI', 'CT'])],
	MD: [office('LWX', 'Baltimore/Washington DC', 'Northeast', ['MD', 'DC', 'VA', 'WV'])],
	ME: [office('CAR', 'Caribou ME', 'Northeast', ['ME'], ['northern maine']), office('GYX', 'Gray ME', 'Northeast', ['ME', 'NH'], ['southern maine'])],
	MI: [office('DTX', 'Detroit/Pontiac MI', 'Great Lakes', ['MI'], ['southeast michigan', 'detroit']), office('GRR', 'Grand Rapids MI', 'Great Lakes', ['MI'], ['western michigan'])],
	MN: [office('MPX', 'Twin Cities MN', 'Upper Midwest', ['MN'], ['southern minnesota', 'twin cities']), office('DLH', 'Duluth MN', 'Upper Midwest', ['MN', 'WI'], ['northern minnesota'])],
	MO: [office('EAX', 'Kansas City/Pleasant Hill MO', 'Midwest', ['MO', 'KS'], ['northern missouri', 'western missouri', 'kansas city']), office('LSX', 'St. Louis MO', 'Midwest', ['MO', 'IL'], ['eastern missouri', 'st louis']), office('SGF', 'Springfield MO', 'Mid-South', ['MO'], ['southern missouri'])],
	MS: [office('JAN', 'Jackson MS', 'Mid-South', ['MS'], ['central mississippi', 'jackson']), office('MEG', 'Memphis TN', 'Mid-South', ['MS', 'TN', 'AR'], ['north mississippi'])],
	MT: [office('BYZ', 'Billings MT', 'West', ['MT'], ['southern montana']), office('TFX', 'Great Falls MT', 'West', ['MT'], ['central montana'])],
	NC: [office('RAH', 'Raleigh NC', 'Southeast', ['NC'], ['central north carolina', 'raleigh']), office('GSO', 'Greensboro NC', 'Southeast', ['NC', 'VA'], ['western north carolina', 'piedmont']), office('ILM', 'Wilmington NC', 'Southeast', ['NC', 'SC'], ['eastern north carolina', 'coastal north carolina'])],
	ND: [office('BIS', 'Bismarck ND', 'Plains', ['ND'], ['central north dakota']), office('FGF', 'Grand Forks ND', 'Upper Midwest', ['ND', 'MN'], ['eastern north dakota'])],
	NE: [office('OAX', 'Omaha/Valley NE', 'Central Plains', ['NE', 'IA'], ['eastern nebraska', 'omaha']), office('GID', 'Hastings NE', 'Central Plains', ['NE', 'KS'], ['south central nebraska']), office('LBF', 'North Platte NE', 'Plains', ['NE'], ['western nebraska'])],
	NH: [office('GYX', 'Gray ME', 'Northeast', ['NH', 'ME'])],
	NJ: [office('PHI', 'Mount Holly NJ', 'Northeast', ['NJ', 'DE', 'PA'], ['south jersey']), office('OKX', 'New York NY', 'Northeast', ['NJ', 'NY', 'CT'], ['north jersey', 'new york metro'])],
	NM: [office('ABQ', 'Albuquerque NM', 'Southwest', ['NM'], ['new mexico', 'albuquerque'])],
	NV: [office('REV', 'Reno NV', 'West', ['NV', 'CA'], ['northern nevada', 'reno']), office('VEF', 'Las Vegas NV', 'Southwest', ['NV'], ['southern nevada', 'las vegas'])],
	NY: [office('BGM', 'Binghamton NY', 'Northeast', ['NY', 'PA'], ['central new york']), office('BUF', 'Buffalo NY', 'Great Lakes', ['NY'], ['western new york', 'buffalo']), office('ALY', 'Albany NY', 'Northeast', ['NY', 'VT', 'MA'], ['eastern new york', 'hudson valley']), office('OKX', 'New York NY', 'Northeast', ['NY', 'NJ', 'CT'], ['downstate new york', 'new york city'])],
	OH: [office('ILN', 'Wilmington OH', 'Ohio Valley', ['OH', 'IN', 'KY'], ['southwest ohio']), office('CLE', 'Cleveland OH', 'Great Lakes', ['OH'], ['northern ohio'])],
	OK: [office('OUN', 'Norman OK', 'Southern Plains', ['OK'], ['central oklahoma', 'oklahoma city']), office('TSA', 'Tulsa OK', 'Southern Plains', ['OK', 'AR'], ['eastern oklahoma', 'tulsa'])],
	OR: [office('PQR', 'Portland OR', 'West', ['OR', 'WA'], ['northwest oregon', 'portland']), office('MFR', 'Medford OR', 'West', ['OR'], ['southern oregon'])],
	PA: [office('CTP', 'State College PA', 'Northeast', ['PA'], ['central pennsylvania']), office('PBZ', 'Pittsburgh PA', 'Ohio Valley', ['PA', 'WV', 'OH'], ['western pennsylvania'])],
	RI: [office('BOX', 'Boston/Norton MA', 'Northeast', ['RI', 'MA', 'CT'])],
	SC: [office('CAE', 'Columbia SC', 'Southeast', ['SC'], ['central south carolina', 'columbia']), office('GSP', 'Greenville-Spartanburg SC', 'Southeast', ['SC', 'NC', 'GA'], ['upstate south carolina']), office('CHS', 'Charleston SC', 'Southeast', ['SC'], ['coastal south carolina'])],
	SD: [office('FSD', 'Sioux Falls SD', 'Upper Midwest', ['SD', 'IA', 'MN'], ['southeast south dakota']), office('ABR', 'Aberdeen SD', 'Plains', ['SD'], ['northeast south dakota']), office('UNR', 'Rapid City SD', 'Plains', ['SD'], ['western south dakota'])],
	TN: [office('OHX', 'Nashville TN', 'Mid-South', ['TN'], ['middle tennessee', 'nashville']), office('MEG', 'Memphis TN', 'Mid-South', ['TN', 'AR', 'MS'], ['west tennessee', 'memphis']), office('MRX', 'Morristown TN', 'Southeast', ['TN'], ['east tennessee'])],
	TX: [office('FWD', 'Fort Worth TX', 'Southern Plains', ['TX'], ['north texas', 'dallas', 'fort worth']), office('EWX', 'Austin/San Antonio TX', 'Southern Plains', ['TX'], ['central texas', 'san antonio', 'austin']), office('SJT', 'San Angelo TX', 'Southern Plains', ['TX'], ['west central texas']), office('LUB', 'Lubbock TX', 'Southern Plains', ['TX', 'NM'], ['west texas', 'south plains']), office('HGX', 'Houston/Galveston TX', 'Gulf Coast', ['TX'], ['southeast texas', 'houston']), office('AMA', 'Amarillo TX', 'Southern Plains', ['TX', 'OK'], ['texas panhandle'])],
	UT: [office('SLC', 'Salt Lake City UT', 'West', ['UT'])],
	VA: [office('RNK', 'Blacksburg VA', 'Southeast', ['VA', 'WV', 'NC'], ['western virginia']), office('AKQ', 'Wakefield VA', 'Southeast', ['VA', 'NC'], ['eastern virginia', 'tidewater']), office('LWX', 'Baltimore/Washington DC', 'Northeast', ['VA', 'MD', 'DC'], ['northern virginia'])],
	VT: [office('BTV', 'Burlington VT', 'Northeast', ['VT', 'NY'])],
	WA: [office('SEW', 'Seattle WA', 'West', ['WA'], ['western washington', 'seattle']), office('OTX', 'Spokane WA', 'West', ['WA', 'ID'], ['eastern washington', 'spokane'])],
	WV: [office('RLX', 'Charleston WV', 'Ohio Valley', ['WV'], ['west virginia', 'charleston']), office('PBZ', 'Pittsburgh PA', 'Ohio Valley', ['WV', 'PA', 'OH'], ['northern west virginia'])],
	WI: [office('MKX', 'Milwaukee/Sullivan WI', 'Great Lakes', ['WI'], ['southern wisconsin', 'milwaukee']), office('ARX', 'La Crosse WI', 'Upper Midwest', ['WI', 'MN', 'IA'], ['western wisconsin']), office('GRB', 'Green Bay WI', 'Great Lakes', ['WI'], ['northeast wisconsin'])],
	WY: [office('CYS', 'Cheyenne WY', 'Plains', ['WY', 'NE', 'CO'], ['southeast wyoming']), office('RIW', 'Riverton WY', 'West', ['WY'], ['central wyoming'])],
};

const REGION_FALLBACK_CODES: Record<string, string[]> = {
	'Upper Midwest': ['DMX', 'MPX', 'MKX'],
	'Great Lakes': ['LOT', 'MKX', 'DTX'],
	'Mid-South': ['LZK', 'MEG', 'OHX'],
	'Southern Plains': ['OUN', 'FWD', 'ICT'],
	'Central Plains': ['TOP', 'OAX', 'GID'],
	Midwest: ['DMX', 'LOT', 'EAX'],
	Southeast: ['FFC', 'BMX', 'CAE'],
	Plains: ['OUN', 'FWD', 'TOP'],
	Southwest: ['ABQ', 'PSR', 'TWC'],
	West: ['STO', 'BOU', 'PQR'],
	Northeast: ['BOX', 'ALY', 'BGM'],
	'Ohio Valley': ['ILN', 'LMK', 'IND'],
	'Gulf Coast': ['LIX', 'HGX', 'JAX'],
};

const OFFICE_BY_CODE = new Map<string, AfdOfficeProfile>(
	Object.values(STATE_AFD_OFFICES)
		.flat()
		.reduce<AfdOfficeProfile[]>((list, profile) => {
			if (list.some((entry) => entry.code === profile.code)) return list;
			list.push(profile);
			return list;
		}, [])
		.map((profile) => [profile.code, profile]),
);

const TIMING_HINT_PATTERNS: AfdHintPattern[] = [
	{ pattern: /late afternoon (?:into|through) (?:the )?evening/i, value: 'late afternoon into evening' },
	{ pattern: /afternoon (?:into|through) (?:the )?evening/i, value: 'afternoon into evening' },
	{ pattern: /late this afternoon/i, value: 'late this afternoon' },
	{ pattern: /this afternoon/i, value: 'this afternoon' },
	{ pattern: /early this evening/i, value: 'early this evening' },
	{ pattern: /this evening/i, value: 'this evening' },
	{ pattern: /overnight/i, value: 'overnight' },
	{ pattern: /after morning clouds? clear|once morning clouds? clear/i, value: 'after morning clouds clear' },
	{ pattern: /toward sunset/i, value: 'toward sunset' },
];

const STORM_MODE_HINT_PATTERNS: AfdHintPattern[] = [
	{ pattern: /fast[- ]moving supercells?/i, value: 'fast-moving supercells' },
	{ pattern: /discrete supercells?/i, value: 'discrete supercells' },
	{ pattern: /supercells?/i, value: 'supercells' },
	{ pattern: /quick upscale growth|rapid upscale growth/i, value: 'quick upscale growth' },
	{ pattern: /squall line|qlcs|line of storms?/i, value: 'squall line' },
	{ pattern: /bow(?:ing)? segments?/i, value: 'bowing line segments' },
	{ pattern: /storm clusters?/i, value: 'storm clusters' },
];

const HAZARD_EMPHASIS_PATTERNS: AfdHintPattern[] = [
	{ pattern: /tornado(?:es)?|warm front tornado/i, value: 'tornado' },
	{ pattern: /damaging winds?|strong wind gusts?|widespread wind damage/i, value: 'damaging wind' },
	{ pattern: /large hail|very large hail/i, value: 'large hail' },
];

const UNCERTAINTY_HINT_PATTERNS: AfdHintPattern[] = [
	{ pattern: /cloud (?:cover|debris).{0,40}limit (?:instability|destabilization)|limited destabilization due to cloud/i, value: 'cloud cover may limit destabilization' },
	{ pattern: /if storms? can remain discrete/i, value: 'storm intensity may depend on whether cells stay discrete' },
	{ pattern: /confidence (?:remains )?limited|low confidence/i, value: 'confidence remains limited' },
	{ pattern: /cap(?:ping)? (?:may|could).{0,30}(?:hold|delay|limit)/i, value: 'capping may delay or limit storm development' },
	{ pattern: /uncertain instability|questionable instability/i, value: 'instability may remain uncertain' },
];

const CONFIDENCE_HINT_PATTERNS: AfdHintPattern[] = [
	{ pattern: /confidence (?:is )?increas/i, value: 'confidence is increasing in organized severe storm development' },
	{ pattern: /good confidence|higher confidence/i, value: 'confidence is improving in the severe setup' },
	{ pattern: /favorable (?:severe )?setup|favorable environment/i, value: 'forecasters see a favorable severe setup if storms develop' },
	{ pattern: /ingredients remain in place|environment remains supportive/i, value: 'the environment still looks supportive for organized storms' },
];

const NOTABLE_BEHAVIOR_HINT_PATTERNS: AfdHintPattern[] = [
	{ pattern: /storms? may move quickly|fast storm motions?/i, value: 'storms may move quickly and reduce warning time' },
	{ pattern: /short warning lead times?/i, value: 'short warning lead times may be possible' },
	{ pattern: /near the warm front|along the warm front/i, value: 'the strongest severe risk may focus near the warm front' },
	{ pattern: /quick upscale growth|storms? should organize quickly/i, value: 'storms may organize quickly once they develop' },
];

function normalizeStateCodes(states: string[]): string[] {
	return dedupeStrings(
		(states || [])
			.map((state) => String(state || '').trim().toUpperCase())
			.filter(Boolean),
	);
}

function normalizeHintList(values: string[]): string[] {
	return dedupeStrings(
		(values || [])
			.map((value) => String(value || '').trim().toLowerCase())
			.filter(Boolean),
	).slice(0, MAX_HINTS_PER_BUCKET);
}

function formatHintList(values: string[]): string[] {
	return normalizeHintList(values)
		.map((value) => {
			if (value === 'qlcs') return 'squall line';
			return value;
		})
		.slice(0, MAX_HINTS_PER_BUCKET);
}

function buildFocusCorpus(summary: Pick<SpcOutlookSummary, 'stateFocusText' | 'summaryText' | 'discussionText' | 'primaryRegion' | 'affectedStates'>): string {
	return [
		summary.stateFocusText,
		summary.summaryText,
		summary.discussionText,
		summary.primaryRegion,
		...normalizeStateCodes(summary.affectedStates || []).map((stateCode) => stateCodeDisplayName(stateCode)),
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function matchedFocusKeywords(profile: AfdOfficeProfile, focusCorpus: string): string[] {
	return dedupeStrings(
		(profile.focusKeywords || [])
			.filter((keyword) => focusCorpus.includes(keyword.toLowerCase())),
	);
}

function scoreOfficeForSummary(
	profile: AfdOfficeProfile,
	summary: Pick<SpcOutlookSummary, 'affectedStates' | 'primaryRegion' | 'stateFocusText' | 'summaryText' | 'discussionText'>,
	focusCorpus: string,
): SpcAfdOfficeSelection | null {
	const affectedStates = normalizeStateCodes(summary.affectedStates || []);
	const stateRank = new Map<string, number>(affectedStates.map((stateCode, index) => [stateCode, index]));
	const matchedStateCodes = profile.states.filter((stateCode) => stateRank.has(stateCode));
	const matchedKeywords = matchedFocusKeywords(profile, focusCorpus);
	const regionMatch = String(profile.primaryRegion || '').toLowerCase() === String(summary.primaryRegion || '').toLowerCase();
	let score = 0;

	for (const stateCode of matchedStateCodes) {
		const index = Number(stateRank.get(stateCode) ?? affectedStates.length);
		score += Math.max(2, 8 - (index * 2));
	}
	if (regionMatch) score += 2;
	score += Math.min(6, matchedKeywords.length * 3);
	if (matchedStateCodes.length === 0 && !regionMatch && matchedKeywords.length === 0) {
		return null;
	}
	if (matchedStateCodes.length === 0 && score < 2) {
		return null;
	}

	return {
		code: profile.code,
		label: profile.label,
		score,
		matchedStateCodes,
		matchedFocusKeywords: matchedKeywords,
	};
}

function pushUniqueSelection(target: SpcAfdOfficeSelection[], next: SpcAfdOfficeSelection) {
	if (target.some((entry) => entry.code === next.code)) return;
	target.push(next);
}

export function selectAfdOfficesForSpcRegion(
	summary: Pick<SpcOutlookSummary, 'affectedStates' | 'primaryRegion' | 'stateFocusText' | 'summaryText' | 'discussionText'>,
	maxOffices = MAX_AFD_OFFICES,
): SpcAfdOfficeSelection[] {
	const affectedStates = normalizeStateCodes(summary.affectedStates || []);
	if (affectedStates.length === 0) return [];
	const focusCorpus = buildFocusCorpus(summary);
	const selected: SpcAfdOfficeSelection[] = [];

	for (const stateCode of affectedStates) {
		const candidates = STATE_AFD_OFFICES[stateCode] || [];
		const scored = candidates
			.map((profile) => scoreOfficeForSummary(profile, summary, focusCorpus))
			.filter((entry): entry is SpcAfdOfficeSelection => !!entry)
			.sort((left, right) => right.score - left.score || left.code.localeCompare(right.code));
		if (scored[0]) {
			pushUniqueSelection(selected, scored[0]);
		}
	}

	const regionFallbacks = REGION_FALLBACK_CODES[String(summary.primaryRegion || '').trim()] || [];
	for (const code of regionFallbacks) {
		if (selected.length >= maxOffices) break;
		const profile = OFFICE_BY_CODE.get(code);
		if (!profile) continue;
		const scored = scoreOfficeForSummary(profile, summary, focusCorpus);
		if (!scored) continue;
		pushUniqueSelection(selected, scored);
	}

	return selected
		.sort((left, right) => right.score - left.score || left.code.localeCompare(right.code))
		.slice(0, maxOffices);
}

function stripTrailingAviationSection(text: string): string {
	const markerIndex = text.toUpperCase().indexOf('.AVIATION');
	return markerIndex >= 0 ? text.slice(0, markerIndex) : text;
}

function normalizeAfdText(text: string): string {
	return stripTrailingAviationSection(String(text || ''))
		.replace(/\r/g, ' ')
		.replace(/\n+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectHints(text: string, patterns: AfdHintPattern[]): string[] {
	const hints: string[] = [];
	for (const { pattern, value } of patterns) {
		if (pattern.test(text)) {
			hints.push(value);
		}
	}
	return formatHintList(hints);
}

export function extractAfdSignalFromText(text: string): SpcAfdSignal {
	const normalizedText = normalizeAfdText(text).toLowerCase();
	return {
		timingHints: collectHints(normalizedText, TIMING_HINT_PATTERNS),
		stormModeHints: collectHints(normalizedText, STORM_MODE_HINT_PATTERNS),
		hazardEmphasis: collectHints(normalizedText, HAZARD_EMPHASIS_PATTERNS),
		uncertaintyHints: collectHints(normalizedText, UNCERTAINTY_HINT_PATTERNS),
		confidenceHints: collectHints(normalizedText, CONFIDENCE_HINT_PATTERNS),
		notableBehaviorHints: collectHints(normalizedText, NOTABLE_BEHAVIOR_HINT_PATTERNS),
	};
}

async function fetchLatestAfdProductText(officeCode: string): Promise<{ productId: string; productText: string } | null> {
	const list = await fetchNwsProductList('AFD', officeCode);
	for (const item of list.slice(0, AFD_PRODUCT_LOOKBACK)) {
		const productId = String(item?.id || '').trim();
		if (!productId) continue;
		const product = await fetchNwsProductById(productId);
		const productText = String(product?.productText || '').trim();
		if (!productText) continue;
		return { productId, productText };
	}
	return null;
}

function mergeSignals(signals: SpcAfdSignal[]): SpcAfdSignal {
	return {
		timingHints: formatHintList(signals.flatMap((signal) => signal.timingHints || [])),
		stormModeHints: formatHintList(signals.flatMap((signal) => signal.stormModeHints || [])),
		hazardEmphasis: formatHintList(signals.flatMap((signal) => signal.hazardEmphasis || [])),
		uncertaintyHints: formatHintList(signals.flatMap((signal) => signal.uncertaintyHints || [])),
		confidenceHints: formatHintList(signals.flatMap((signal) => signal.confidenceHints || [])),
		notableBehaviorHints: formatHintList(signals.flatMap((signal) => signal.notableBehaviorHints || [])),
	};
}

export async function buildSpcAfdEnrichment(
	summary: Pick<SpcOutlookSummary, 'affectedStates' | 'primaryRegion' | 'stateFocusText' | 'summaryText' | 'discussionText'>,
	maxOffices = MAX_AFD_OFFICES,
): Promise<SpcAfdEnrichment | null> {
	const selectedOffices = selectAfdOfficesForSpcRegion(summary, maxOffices);
	if (selectedOffices.length === 0) return null;

	const results = await Promise.all(
		selectedOffices.map(async (selection) => {
			try {
				const product = await fetchLatestAfdProductText(selection.code);
				if (!product) return { selection, productId: '', signal: null, failed: true };
				return {
					selection,
					productId: product.productId,
					signal: extractAfdSignalFromText(product.productText),
					failed: false,
				};
			} catch {
				return { selection, productId: '', signal: null, failed: true };
			}
		}),
	);

	const usableSignals = results
		.filter((result) => !result.failed && result.signal)
		.map((result) => result.signal as SpcAfdSignal);
	if (usableSignals.length === 0) {
		console.warn(`[fb-spc-afd] no usable AFDs for states=${normalizeStateCodes(summary.affectedStates || []).join('|')}`);
		return null;
	}

	const enrichment: SpcAfdEnrichment = {
		...mergeSignals(usableSignals),
		selectedOffices,
		sourceProductIds: results.map((result) => result.productId).filter(Boolean),
		failedOfficeCodes: results.filter((result) => result.failed).map((result) => result.selection.code),
		fetchedAt: new Date().toISOString(),
	};

	const hintSummary = [
		`timing=${enrichment.timingHints.length}`,
		`mode=${enrichment.stormModeHints.length}`,
		`hazard=${enrichment.hazardEmphasis.length}`,
		`uncertainty=${enrichment.uncertaintyHints.length}`,
		`confidence=${enrichment.confidenceHints.length}`,
		`behavior=${enrichment.notableBehaviorHints.length}`,
	].join(' ');
	console.log(`[fb-spc-afd] offices=${selectedOffices.map((officeSelection) => officeSelection.code).join(',')} ${hintSummary}`);
	return enrichment;
}
