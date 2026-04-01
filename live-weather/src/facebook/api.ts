import type {
	Env,
	AlertThread,
	FacebookPublishOptions,
	FacebookPublishResult,
	FbAutoPostMode,
	FbAutoPostConfig,
} from '../types';
import {
	FB_GRAPH_API,
	FB_TIMEOUT_MS,
	PRIMARY_APP_ORIGIN,
} from '../constants';
import {
	slugify,
	normalizeEventSlug,
	alertImageCategory,
	extractStateCode,
	stateCodeToName,
	getEventSlugVariants,
} from '../utils';
import {
	normalizeFacebookPublishThreadAction,
	readExistingThreadForFeature,
	writeThread,
	writeStormClusterThreads,
} from './threads';
import {
	buildAlertPostedSnapshot,
	buildAnchorPostText,
	buildFacebookUpdateCommentMessage,
	isDefaultAdminFacebookMessage,
} from './text';
import {
	writeFbAppConfig,
	writeFbAutoPostConfig,
	buildFbAutoPostStatusText,
} from './config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fbAbortSignal(): AbortSignal {
	return AbortSignal.timeout(FB_TIMEOUT_MS);
}

export async function urlExists(url: string): Promise<boolean> {
	try {
		let res = await fetch(url, { method: 'HEAD' });
		if (res.ok) return true;
		if (res.status === 405 || res.status === 501) {
			res = await fetch(url, { method: 'GET' });
			return res.ok;
		}
	} catch {
		// ignore network errors; treat as missing
	}
	return false;
}

function getAlertImageBaseUrl(env: Env, request?: Request | null): string {
	const configuredBase = String(env.FB_IMAGE_BASE_URL || '').trim().replace(/\/$/, '');
	if (configuredBase) return configuredBase;
	if (request) return new URL(request.url).origin;
	return PRIMARY_APP_ORIGIN;
}

function getAlertImageCandidates(state: string, event: string): string[] {
	const stateSlug = slugify(state);
	const eventSlug = normalizeEventSlug(event);
	const category = slugify(alertImageCategory(event));
	const eventSlugs = getEventSlugVariants(event, eventSlug);

	const list: string[] = [];
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

export async function findAlertImageUrl(
	env: Env,
	feature: any,
	request?: Request | null,
): Promise<string | null> {
	const base = getAlertImageBaseUrl(env, request);
	const event = String(feature?.properties?.event || '');
	const stateCode = extractStateCode(feature);
	const stateName = stateCodeToName(stateCode);
	const candidates = getAlertImageCandidates(stateName, event);

	for (const candidate of candidates) {
		const candidateUrl = new URL(candidate, base).toString();
		if (await urlExists(candidateUrl)) {
			return candidateUrl;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Facebook API calls
// ---------------------------------------------------------------------------

async function postPhotoToFacebook(env: Env, message: string, imageUrl: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/photos`;
	const body = new URLSearchParams({ url: imageUrl, caption: message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook photo API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook photo post succeeded but returned no post ID');
	return data.id;
}

/** Create a new post on the Facebook page. Returns the post ID string. */
async function postToFacebook(env: Env, message: string, imageUrl?: string): Promise<string> {
	if (imageUrl) {
		try {
			return await postPhotoToFacebook(env, message, imageUrl);
		} catch (err) {
			console.error('Image post failed, falling back to feed:', String(err));
		}
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook post succeeded but returned no post ID');
	return data.id;
}

/** Post a comment on an existing Facebook post. */
async function commentOnFacebook(env: Env, postId: string, message: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(postId)}/comments`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook comment API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	return data.id ?? '';
}

export async function publishFeatureToFacebook(
	env: Env,
	feature: any,
	options: FacebookPublishOptions = {},
): Promise<FacebookPublishResult> {
	const properties = feature?.properties ?? {};
	const rawCustomMessage = String(options.customMessage || '').trim();
	const threadAction = normalizeFacebookPublishThreadAction(options.threadAction);
	const event = String(properties.event ?? 'Weather Alert');
	const nowIso = new Date().toISOString();
	const currentSnapshot = buildAlertPostedSnapshot(properties);
	const ugcCodes: string[] = Array.isArray(properties.geocode?.UGC) && properties.geocode.UGC.length > 0
		? properties.geocode.UGC
		: ['UNKNOWN'];
	const expiresAt = properties.expires
		? Math.floor(new Date(properties.expires).getTime() / 1000)
		: 0;

	let existingThread: AlertThread | null = null;
	if (threadAction !== 'new_post') {
		existingThread = await readExistingThreadForFeature(env, feature, event);
	}

	if (!existingThread || threadAction === 'new_post') {
		const anchorMessage = rawCustomMessage || buildAnchorPostText(properties);
		const imageUrl = String(options.imageUrl || '').trim()
			|| await findAlertImageUrl(env, feature, options.request);
		const postId = await postToFacebook(env, anchorMessage, imageUrl || undefined);
		const nextThread: AlertThread = {
			postId,
			nwsAlertId: String(feature?.id ?? ''),
			expiresAt,
			county: String(properties.areaDesc ?? ''),
			alertType: event,
			updateCount: 0,
			lastPostedAt: nowIso,
			lastPostedSnapshot: currentSnapshot,
		};
		for (const ugcCode of ugcCodes) {
			await writeThread(env, ugcCode, { ...nextThread });
		}
		await writeStormClusterThreads(env, feature, event, nextThread);
		return {
			id: String(feature?.id ?? ''),
			status: 'posted',
			postId,
		};
	}

	const currentCount = existingThread.updateCount ?? 0;
	const forceComment = threadAction === 'comment';
	const commentCustomMessage = isDefaultAdminFacebookMessage(rawCustomMessage, properties) ? '' : rawCustomMessage;

	if (forceComment || currentCount < 3) {
		const fullComment = commentCustomMessage
			? commentCustomMessage
			: buildFacebookUpdateCommentMessage(properties, existingThread.lastPostedSnapshot ?? null);
		const commentId = await commentOnFacebook(env, existingThread.postId, fullComment);
		const updatedThread: AlertThread = {
			...existingThread,
			nwsAlertId: String(feature?.id ?? ''),
			expiresAt,
			updateCount: currentCount + 1,
			lastPostedAt: nowIso,
			lastPostedSnapshot: currentSnapshot,
		};
		for (const ugcCode of ugcCodes) {
			await writeThread(env, ugcCode, { ...updatedThread });
		}
		await writeStormClusterThreads(env, feature, event, updatedThread);
		return {
			id: String(feature?.id ?? ''),
			status: 'commented',
			postId: existingThread.postId,
			commentId,
			updateCount: currentCount + 1,
		};
	}

	try {
		await commentOnFacebook(
			env,
			existingThread.postId,
			`🔄 Continuing coverage of this ${event} has moved to a new post.`,
		);
	} catch {
		// Ignore failures here; the new anchor post matters.
	}

	const anchorMessage = rawCustomMessage || buildAnchorPostText(properties);
	const imageUrl = String(options.imageUrl || '').trim()
		|| await findAlertImageUrl(env, feature, options.request);
	const postId = await postToFacebook(env, anchorMessage, imageUrl || undefined);
	const chainedThread: AlertThread = {
		postId,
		nwsAlertId: String(feature?.id ?? ''),
		expiresAt,
		county: String(properties.areaDesc ?? ''),
		alertType: event,
		updateCount: 0,
		lastPostedAt: nowIso,
		lastPostedSnapshot: currentSnapshot,
	};
	for (const ugcCode of ugcCodes) {
		await writeThread(env, ugcCode, { ...chainedThread });
	}
	await writeStormClusterThreads(env, feature, event, chainedThread);
	return {
		id: String(feature?.id ?? ''),
		status: 'posted',
		postId,
		chainBreak: true,
	};
}

// ---------------------------------------------------------------------------
// Token exchange & admin config handlers
// ---------------------------------------------------------------------------

async function exchangeFacebookToken(appId: string, appSecret: string, userToken: string): Promise<string> {
	const url = `${FB_GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token` +
		`&client_id=${encodeURIComponent(appId)}` +
		`&client_secret=${encodeURIComponent(appSecret)}` +
		`&fb_exchange_token=${encodeURIComponent(userToken)}`;
	const res = await fetch(url, { method: 'GET', signal: fbAbortSignal() });
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Facebook token exchange API error ${res.status}: ${text}`);
	}
	const data = JSON.parse(text);
	if (!data.access_token) {
		throw new Error(`Unexpected response from Facebook token exchange: ${text}`);
	}
	return data.access_token;
}

export async function handleTokenExchange(
	request: Request,
	env: Env,
	isAuthenticated: (req: Request, env: Env) => Promise<boolean>,
	parseRequestBody: (req: Request) => Promise<URLSearchParams>,
): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const form = await parseRequestBody(request);
	const appId = (form.get('appId') || '').trim();
	const appSecret = (form.get('appSecret') || '').trim();
	const userToken = (form.get('userToken') || '').trim();
	if (!appId || !appSecret || !userToken) {
		return new Response(JSON.stringify({ error: 'appId, appSecret, and userToken are required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	try {
		const longLivedToken = await exchangeFacebookToken(appId, appSecret, userToken);
		return new Response(JSON.stringify({ access_token: longLivedToken }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		return new Response(JSON.stringify({ error: String(err) }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

export async function handleTokenConfig(
	request: Request,
	env: Env,
	isAuthenticated: (req: Request, env: Env) => Promise<boolean>,
	parseRequestBody: (req: Request) => Promise<URLSearchParams>,
): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const form = await parseRequestBody(request);
	const appId = (form.get('appId') || '').trim();
	const appSecret = (form.get('appSecret') || '').trim();
	if (!appId || !appSecret) {
		return new Response(JSON.stringify({ error: 'appId and appSecret are required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	await writeFbAppConfig(env, { appId, appSecret });
	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

export async function handleAutoPostConfig(
	request: Request,
	env: Env,
	isAuthenticated: (req: Request, env: Env) => Promise<boolean>,
	parseRequestBody: (req: Request) => Promise<URLSearchParams>,
): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const form = await parseRequestBody(request);
	const rawMode = String(form.get('mode') || '').trim().toLowerCase();
	let mode: FbAutoPostMode | null = null;

	if (rawMode) {
		if (
			rawMode === 'off'
			|| rawMode === 'tornado_only'
			|| rawMode === 'smart_high_impact'
		) {
			mode = rawMode as FbAutoPostMode;
		} else {
			return new Response(JSON.stringify({ error: 'mode must be off, tornado_only, or smart_high_impact' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	if (!mode) {
		const rawValue = String(form.get('tornadoWarningsEnabled') || '').trim().toLowerCase();
		if (!['true', 'false', '1', '0', 'on', 'off'].includes(rawValue)) {
			return new Response(JSON.stringify({ error: 'mode is required' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		mode = rawValue === 'true' || rawValue === '1' || rawValue === 'on'
			? 'tornado_only'
			: 'off';
	}

	function parseBoolField(key: string): boolean {
		const v = String(form.get(key) || '').trim().toLowerCase();
		return v === 'true' || v === '1' || v === 'on';
	}
	const digestCoverageEnabled = parseBoolField('digestCoverageEnabled');
	const llmCopyEnabled = parseBoolField('llmCopyEnabled');
	const startupCatchupEnabled = parseBoolField('startupCatchupEnabled');

	const nextConfig: FbAutoPostConfig = {
		mode,
		updatedAt: new Date().toISOString(),
		digestCoverageEnabled: digestCoverageEnabled,
		llmCopyEnabled: llmCopyEnabled,
		startupCatchupEnabled: startupCatchupEnabled,
	};
	await writeFbAutoPostConfig(env, nextConfig);

	return new Response(JSON.stringify({
		success: true,
		config: nextConfig,
		message: buildFbAutoPostStatusText(nextConfig),
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
