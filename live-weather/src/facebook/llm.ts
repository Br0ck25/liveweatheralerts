import type { Env, DigestSummary, LlmPromptPayload, LlmPostValidationResult } from '../types';

const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LLM_MAX_TOKENS = 350;
const DIGEST_MAX_CHARS = 500;

const SYSTEM_PROMPT = [
	'You are a national weather desk writer for a public weather alert service.',
	'Write clear, concise, factual Facebook posts summarizing active weather alerts.',
	'Rules: max 2 short paragraphs. No emojis. No hashtags. No county lists.',
	'Do not use exaggerated words like "historic" or "catastrophic" unless the data supports them.',
	'Do not invent safety advice not supported by the alerts. Write in plain English.',
	'Answer the question: what is happening right now across the country?',
].join(' ');

function buildUserPrompt(payload: LlmPromptPayload): string {
	const hazardLabel = payload.hazard_focus
		? `Hazard focus: ${payload.hazard_focus}.`
		: 'Multiple hazard types.';
	const stateList = payload.states.length > 0
		? `Affected states: ${payload.states.join(', ')}.`
		: 'Multiple states affected.';
	const alertList = payload.top_alert_types.length > 0
		? `Primary alert types: ${payload.top_alert_types.join(', ')}.`
		: '';
	return [
		`Situation: ${payload.mode === 'incident' ? 'High-volume national alert surge.' : 'Active weather alerts.'}`,
		hazardLabel,
		stateList,
		alertList,
		`Urgency: ${payload.urgency}.`,
		`Write a Facebook post of no more than ${payload.max_length} characters.`,
		`Style: ${payload.style}`,
	].filter(Boolean).join(' ');
}

function buildLlmPayload(summary: DigestSummary): LlmPromptPayload {
	return {
		mode: summary.mode,
		post_type: summary.postType,
		hazard_focus: summary.hazardFocus,
		states: summary.states,
		top_alert_types: summary.topAlertTypes,
		urgency: summary.urgency,
		max_length: 450,
		style: 'national weather desk, clear, concise, no hype',
	};
}

export function validateLlmOutput(text: string, payload: LlmPromptPayload): LlmPostValidationResult {
	const trimmed = text.trim();

	if (!trimmed) {
		return { valid: false, text: trimmed, failureReason: 'empty_output' };
	}
	if (trimmed.length > DIGEST_MAX_CHARS) {
		return { valid: false, text: trimmed, failureReason: 'too_long' };
	}
	// Must mention at least one state or a geography marker
	const mentionsGeo = payload.states.some((s) => trimmed.toLowerCase().includes(s.toLowerCase()))
		|| /\b(?:nation|national|country|u\.s\.|u\.?s\.?\s*(?:wide|weather)|midwest|northeast|southeast|southwest|northwest|plains|rockies)\b/i.test(trimmed);
	if (!mentionsGeo) {
		return { valid: false, text: trimmed, failureReason: 'no_geography_mention' };
	}
	// Reject banned words that are unsupported
	if (/\bhashTag\b|#\w/i.test(trimmed)) {
		return { valid: false, text: trimmed, failureReason: 'contains_hashtag' };
	}
	return { valid: true, text: trimmed };
}

function buildFallbackTemplate(summary: DigestSummary): string {
	const hazardLine = summary.hazardFocus
		? `${capitalizeHazard(summary.hazardFocus)} alerts are active`
		: 'Weather alerts are active';
	const stateList = summary.states.length > 0
		? ` across ${formatStateList(summary.states)}`
		: ' across multiple states';
	const alertTypeLine = summary.topAlertTypes.length > 0
		? ` including ${summary.topAlertTypes.slice(0, 2).join(' and ')}`
		: '';
	return [
		`${hazardLine}${stateList}${alertTypeLine}.`,
		'Monitor local forecasts and follow guidance from your local National Weather Service office.',
	'Full details: https://liveweatheralerts.com/live',
	].join('\n\n');
}

function capitalizeHazard(family: string): string {
	const labels: Record<string, string> = {
		flood: 'Flood',
		winter: 'Winter weather',
		wind: 'High wind',
		fire: 'Fire weather',
		other: 'Weather',
	};
	return labels[family] ?? 'Weather';
}

function formatStateList(states: string[]): string {
	if (states.length === 0) return 'multiple states';
	if (states.length <= 3) return states.join(', ');
	return `${states.slice(0, 3).join(', ')} and ${states.length - 3} other state${states.length - 3 !== 1 ? 's' : ''}`;
}

export async function generateDigestCopy(env: Env, summary: DigestSummary): Promise<string> {
	const payload = buildLlmPayload(summary);

	if (env.AI) {
		try {
			const result = await env.AI.run(LLM_MODEL, {
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: buildUserPrompt(payload) },
				],
				max_tokens: LLM_MAX_TOKENS,
			}) as { response?: string };

			const raw = String(result?.response || '').trim();
			const validation = validateLlmOutput(raw, payload);
			if (validation.valid) {
				return validation.text;
			}
			console.warn(`[fb-llm] validation failed: ${validation.failureReason}, falling back to template`);
		} catch (err) {
			console.error(`[fb-llm] Workers AI error: ${String(err)}, falling back to template`);
		}
	}

	return buildFallbackTemplate(summary);
}

/**
 * Returns the appropriate copy function based on whether LLM copy is enabled.
 * When disabled, always uses the deterministic template fallback.
 */
export function createDigestCopyFn(
	llmEnabled: boolean,
): (env: Env, summary: DigestSummary) => Promise<string> {
	if (llmEnabled) return generateDigestCopy;
	return async (_env: Env, summary: DigestSummary) => buildFallbackTemplate(summary);
}
