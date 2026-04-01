import type { AlertPostedSnapshot } from '../types';
import { PUBLIC_ALERTS_PAGE_PATH } from '../constants';
import {
	alertToText,
	findProperty,
	isCountyTableDescription,
	formatAlertDescription,
	formatDateTimeShort,
} from '../utils';

// ---------------------------------------------------------------------------
// Anchor post text generation
// ---------------------------------------------------------------------------

export function buildAnchorPostText(properties: any): string {
	const caption = alertToText(properties);
	const hashtagLine = '#weatheralert #weather #alert';
	const base = caption.endsWith(hashtagLine)
		? caption.slice(0, -hashtagLine.length).trimEnd()
		: caption.trimEnd();
	return `${base}\n\n🔄 Updates will be posted in the comments as conditions change.\n\n${hashtagLine}`;
}

export function buildCommentText(text: string): string {
	const lines = text.split('\n');
	const filtered = lines.filter(line => {
		const trimmed = line.trim();
		if (trimmed.startsWith('#')) return false;
		if (/^https?:\/\//i.test(trimmed)) {
			try {
				const url = new URL(trimmed);
				const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
				if (normalizedPath === PUBLIC_ALERTS_PAGE_PATH) return false;
			} catch {
				// Ignore malformed URLs and keep the line.
			}
		}
		return true;
	});
	while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
		filtered.pop();
	}
	return filtered.join('\n');
}

function normalizeAlertComparisonText(text: string): string {
	return String(text || '')
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.toLowerCase();
}

function splitAlertParagraphs(text: string): string[] {
	return String(text || '')
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
}

function uniqueAlertSections(sections: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const section of sections) {
		const trimmed = String(section || '').trim();
		if (!trimmed) continue;
		const key = normalizeAlertComparisonText(trimmed);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(trimmed);
	}
	return unique;
}

function diffAlertParagraphs(currentText: string, previousText: string): string[] {
	const previousKeys = new Set(splitAlertParagraphs(previousText).map(normalizeAlertComparisonText));
	return splitAlertParagraphs(currentText).filter((paragraph) =>
		!previousKeys.has(normalizeAlertComparisonText(paragraph)),
	);
}

export function buildAlertPostedSnapshot(properties: any): AlertPostedSnapshot {
	const headline = properties.headline
		?? findProperty(properties, 'NWSheadline')
		?? '';
	const rawDescription = String(properties.description || '');
	const description = isCountyTableDescription(rawDescription)
		? ''
		: formatAlertDescription(rawDescription);
	const instruction = properties.instruction
		? formatAlertDescription(String(properties.instruction))
		: '';
	return {
		areaDesc: String(properties.areaDesc || '').trim(),
		expires: properties.expires ? formatDateTimeShort(properties.expires) : '',
		severity: String(properties.severity || '').trim(),
		headline: String(headline || '').trim(),
		description: String(description || '').trim(),
		instruction: String(instruction || '').trim(),
	};
}

export function buildFacebookUpdateCommentMessage(
	properties: any,
	previousSnapshot: AlertPostedSnapshot | null = null,
): string {
	const event = String(properties.event ?? 'Weather Alert');
	const currentSnapshot = buildAlertPostedSnapshot(properties);
	const sections: string[] = [];

	if (previousSnapshot) {
		if (
			currentSnapshot.areaDesc
			&& normalizeAlertComparisonText(currentSnapshot.areaDesc) !== normalizeAlertComparisonText(previousSnapshot.areaDesc)
		) {
			sections.push(`Area: ${currentSnapshot.areaDesc}`);
		}
		if (
			currentSnapshot.expires
			&& normalizeAlertComparisonText(currentSnapshot.expires) !== normalizeAlertComparisonText(previousSnapshot.expires)
		) {
			sections.push(`Expires: ${currentSnapshot.expires}`);
		}
		if (
			currentSnapshot.severity
			&& normalizeAlertComparisonText(currentSnapshot.severity) !== normalizeAlertComparisonText(previousSnapshot.severity)
		) {
			sections.push(`Severity: ${currentSnapshot.severity}`);
		}
		if (
			currentSnapshot.headline
			&& normalizeAlertComparisonText(currentSnapshot.headline) !== normalizeAlertComparisonText(previousSnapshot.headline)
		) {
			sections.push(currentSnapshot.headline);
		}
		sections.push(...diffAlertParagraphs(currentSnapshot.description, previousSnapshot.description));
		sections.push(...diffAlertParagraphs(currentSnapshot.instruction, previousSnapshot.instruction));
	} else {
		if (currentSnapshot.expires) sections.push(`Expires: ${currentSnapshot.expires}`);
		if (currentSnapshot.severity) sections.push(`Severity: ${currentSnapshot.severity}`);
		if (currentSnapshot.headline) sections.push(currentSnapshot.headline);
		if (currentSnapshot.description) sections.push(currentSnapshot.description);
		if (currentSnapshot.instruction) sections.push(currentSnapshot.instruction);
	}

	const uniqueSections = uniqueAlertSections(sections);
	const body = uniqueSections.length > 0
		? uniqueSections.join('\n\n')
		: 'NWS updated this alert with no major text changes.';
	return `🔄 UPDATE — ${event} for ${currentSnapshot.areaDesc || String(properties.areaDesc || '')}\n\n${body}`.trim();
}

export function isDefaultAdminFacebookMessage(customMessage: string, properties: any): boolean {
	const normalizedMessage = normalizeAlertComparisonText(customMessage);
	if (!normalizedMessage) return false;
	const defaultMessages = [
		alertToText(properties),
		buildAnchorPostText(properties),
		buildCommentText(alertToText(properties)),
	].map(normalizeAlertComparisonText);
	return defaultMessages.includes(normalizedMessage);
}
