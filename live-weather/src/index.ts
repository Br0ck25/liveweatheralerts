// ---------------------------------------------------------------------------
// Thin entry point — all business logic lives in the modules below.
// ---------------------------------------------------------------------------

import type { Env } from './types';
import {
	normalizeStateCode,
	formatAlertDescription,
	deriveAlertImpactCategories,
	isMajorImpactAlertEvent,
	canonicalAlertDetailUrl,
	extractCountyFipsCodes,
	alertToText,
} from './utils';
import {
	corsHeaders,
	apiCorsHeaders,
	pushCorsHeaders,
	debugCorsHeaders,
	normalizeAlertFeature,
	handlePushPublicKey,
	handlePushSubscribe,
	handlePushTest,
	handlePushUnsubscribe,
	handleApiAlerts,
	handleApiAlertDetail,
	handleApiAlertHistory,
	handleApiAlertChanges,
	handleApiDebugSummary,
} from './public-api';
import {
	diffAlertLifecycleSnapshots,
	normalizeAlertChangeRecord,
	normalizeAlertHistoryDayRecord,
	buildNextAlertHistoryByDay,
	syncAlertHistoryDailySnapshots,
	syncAlertLifecycleState,
} from './alert-lifecycle';
import {
	alertMatchesScopeCounty,
	alertMatchesScopeRadius,
	featureMatchesScope,
	normalizePushPreferences,
} from './push/subscriptions';
import {
	buildStatePushMessageData,
	buildLifecyclePushMessageData,
	shouldSendAllClearNotification,
	batchLifecycleEntriesForDeliveryMode,
	changeMatchesScope,
	dispatchStatePushNotifications,
} from './push/delivery';
import {
	buildCommentText,
	buildAlertPostedSnapshot,
	buildFacebookUpdateCommentMessage,
} from './facebook/text';
import { normalizeFbAutoPostConfig, matchingMetroNamesForAlert } from './facebook/config';
import {
	evaluateFacebookAutoPostDecision,
	autoPostHazardClusterFamilyForEvent,
	buildAutoPostHazardClusterCommentMessage,
	buildAutoPostHazardClusterPlans,
	hasSevereThunderstormDestructiveCriteria,
	scoreAutoPostHazardClusterCandidate,
	selectSevereWeatherFallbackOverrides,
	autoPostFacebookAlerts,
	evaluateAutoPostIntent,
} from './facebook/auto-post';
import { buildAdminFacebookPostRankings } from './facebook/ranking';
import { handleTokenExchange, handleTokenConfig, handleAutoPostConfig } from './facebook/api';
import {
	buildDigestCandidates,
	buildHazardClusters,
	buildDigestSummary,
	buildStartupSnapshotText,
	checkClusterBreakout,
	canPostNewDigest,
	evaluateDigestChangeThresholds,
	evaluateDigestNewPostGap,
	evaluateDigestSameStory,
	evaluateSecondDigestPostAllowance,
	evaluateDigestStoryContinuity,
	getDigestImageUrl,
	readDigestThread,
	readStandaloneCoveredAlerts,
	markAlertStandaloneCovered,
	isStartupMode,
	runDigestCoverage,
	evaluateDigestCoverageIntent,
	selectDigestRegionalStory,
	selectDigestPrimaryCluster,
} from './facebook/digest';
import {
	buildLlmPayload,
	buildCommentChangeHint,
	buildUserPrompt,
	generateDigestCopy,
	readRecentDigestOpenings,
	recordRecentDigestOpening,
	validateLlmOutput,
} from './facebook/llm';
import {
	buildSpcLlmPayload,
	buildSpcUserPrompt,
	validateSpcLlmOutput,
} from './facebook/spc-llm';
import {
	buildSpcDay1OutlookSummary,
	buildSpcDay1WatchCommentText,
	buildSpcCommentChangeHint as buildSpcCommentChangeHintHelper,
	buildSpcHazardLine,
	evaluateSpcPostingSchedule,
	buildSpcOutlookSummary,
	buildSpcPostDecision,
	buildSpcPostText,
	fetchLatestSpcOutlookSummary,
	fetchLatestSpcDay1OutlookSummary,
	parseSpcOutlookPage,
	parseSpcDay1OutlookPage,
	readLastSpcPost,
	readLastSpcSummary,
	readLastSpcDay1Post,
	readLastSpcDay1Summary,
	readSpcThreadRecord,
	readRecentSpcOpenings,
	recordRecentSpcOpening,
	recordSpcThreadCommentActivity,
	readSpcDebugSnapshot,
	runSpcCoverage,
	runSpcCoverageForDay,
	runSpcDay1Coverage,
	evaluateSpcCoverageIntentForDay,
	evaluateSpcCoverageIntents,
	normalizeSpcMinRiskLevel,
	selectSpcPrimaryRiskArea,
	spcSummaryOverlapStates,
} from './facebook/spc';
import {
	runCoordinatedFacebookCoverage,
	readFacebookCoordinatorSnapshot,
	selectFacebookCoverageIntent,
} from './facebook/coordinator';
import { isAuthenticated, parseRequestBody } from './admin/auth';
import { shouldSuppressAlertFromUi, syncAlerts, recordInvalidSubscription, recordPushDeliveryFailure } from './nws';
import { handleApiGeocode, handleApiLocation } from './weather/geocoding';
import { handleApiWeather, handleApiRadar } from './weather/api';
import {
	handleAdminForecastData,
	handleAdminDiscussionData,
	handleAdminConvectiveOutlookData,
} from './weather/forecast';
import {
	buildSpcAfdEnrichment,
	extractAfdSignalFromText,
	selectAfdOfficesForSpcRegion,
} from './weather/afd';
import {
	handleAdminLogin,
	handleAdminPage,
	handleThreadCheck,
	handlePost,
} from './admin/page';

// ---------------------------------------------------------------------------
// Static-asset helpers
// ---------------------------------------------------------------------------

function renderMissingPublicAppResponse(): Response {
	return new Response(
		'Public app assets are unavailable. Run the frontend build before starting or deploying the worker.',
		{
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		},
	);
}

async function servePublicAppIndex(request: Request, env: Env): Promise<Response> {
	if (!env.ASSETS) {
		return renderMissingPublicAppResponse();
	}
	// Fetch the root path ('/') rather than '/index.html' — Cloudflare Workers Assets
	// redirects direct requests for '/index.html' to '/' (canonical URL normalization),
	// which would cause a 307 redirect loop for any non-root SPA routes like '/live'.
	const assetUrl = new URL(request.url);
	assetUrl.pathname = '/';
	assetUrl.search = '';
	const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
	if (response.status === 404) {
		return renderMissingPublicAppResponse();
	}
	// Strip any Location / redirect headers so the browser stays on the original URL.
	if (response.status >= 300 && response.status < 400) {
		const body = await response.text();
		return new Response(body || null, {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}
	return response;
}

async function serveStaticAsset(request: Request, env: Env): Promise<Response | null> {
	if (!env.ASSETS) {
		return null;
	}
	const response = await env.ASSETS.fetch(request);
	return response.status === 404 ? null : response;
}

// ---------------------------------------------------------------------------
// Canonical URL helpers (used in redirect routes)
// ---------------------------------------------------------------------------

function canonicalAlertsPageUrl(stateCode?: string | null): string {
	const normalizedState = normalizeStateCode(stateCode || '');
	const params = new URLSearchParams();
	params.set('tab', 'alerts');
	if (normalizedState) {
		params.set('state', normalizedState);
	}
	const query = params.toString();
	return query ? `/?${query}` : '/';
}

function canonicalSettingsUrl(): string {
	return '/?tab=more';
}

function redirectToCanonicalAppUrl(request: Request, targetPath: string, status = 302): Response {
	return Response.redirect(new URL(targetPath, request.url).toString(), status);
}

// ---------------------------------------------------------------------------
// Scheduled handler — cron trigger every 2 minutes
// ---------------------------------------------------------------------------

async function handleScheduled(env: Env): Promise<void> {
	const { map } = await syncAlerts(env);
	const lifecycleDiff = await syncAlertLifecycleState(env, map);
	await syncAlertHistoryDailySnapshots(env, map, lifecycleDiff.changes);
	await runCoordinatedFacebookCoverage(env, map, lifecycleDiff.changes);
	await dispatchStatePushNotifications(env, map, lifecycleDiff.changes, recordInvalidSubscription, recordPushDeliveryFailure);
}

// ---------------------------------------------------------------------------
// Test surface — re-exported symbols consumed by test/index.spec.ts
// ---------------------------------------------------------------------------

export const __testing = {
	formatAlertDescription,
	normalizeAlertFeature,
	buildStatePushMessageData,
	buildLifecyclePushMessageData,
	deriveAlertImpactCategories,
	isMajorImpactAlertEvent,
	shouldSendAllClearNotification,
	batchLifecycleEntriesForDeliveryMode,
	diffAlertLifecycleSnapshots,
	normalizeAlertChangeRecord,
	normalizeAlertHistoryDayRecord,
	buildNextAlertHistoryByDay,
	canonicalAlertDetailUrl,
	extractCountyFipsCodes,
	alertMatchesScopeCounty,
	alertMatchesScopeRadius,
	featureMatchesScope,
	changeMatchesScope,
	normalizePushPreferences,
	alertToText,
	buildCommentText,
	buildAlertPostedSnapshot,
	buildFacebookUpdateCommentMessage,
	normalizeFbAutoPostConfig,
	evaluateFacebookAutoPostDecision,
	autoPostHazardClusterFamilyForEvent,
	buildAutoPostHazardClusterCommentMessage,
	buildAutoPostHazardClusterPlans,
	matchingMetroNamesForAlert,
	hasSevereThunderstormDestructiveCriteria,
	scoreAutoPostHazardClusterCandidate,
	selectSevereWeatherFallbackOverrides,
	buildAdminFacebookPostRankings,
	shouldSuppressAlertFromUi,
	autoPostFacebookAlerts,
	evaluateAutoPostIntent,
	// Digest / coverage
	buildDigestCandidates,
	buildHazardClusters,
	buildDigestSummary,
	buildStartupSnapshotText,
	checkClusterBreakout,
	canPostNewDigest,
	evaluateDigestChangeThresholds,
	evaluateDigestNewPostGap,
	evaluateDigestSameStory,
	evaluateSecondDigestPostAllowance,
	evaluateDigestStoryContinuity,
	getDigestImageUrl,
	readDigestThread,
	readStandaloneCoveredAlerts,
	markAlertStandaloneCovered,
	isStartupMode,
	runDigestCoverage,
	evaluateDigestCoverageIntent,
	selectDigestRegionalStory,
	selectDigestPrimaryCluster,
	buildLlmPayload,
	buildCommentChangeHint,
	buildUserPrompt,
	generateDigestCopy,
	readRecentDigestOpenings,
	recordRecentDigestOpening,
	validateLlmOutput,
	buildSpcDay1OutlookSummary,
	buildSpcDay1WatchCommentText,
	buildSpcCommentChangeHint: buildSpcCommentChangeHintHelper,
	buildSpcHazardLine,
	buildSpcLlmPayload,
	evaluateSpcPostingSchedule,
	buildSpcOutlookSummary,
	buildSpcPostDecision,
	buildSpcPostText,
	buildSpcUserPrompt,
	fetchLatestSpcOutlookSummary,
	fetchLatestSpcDay1OutlookSummary,
	parseSpcOutlookPage,
	parseSpcDay1OutlookPage,
	readLastSpcPost,
	readLastSpcSummary,
	readLastSpcDay1Post,
	readLastSpcDay1Summary,
	readSpcThreadRecord,
	readRecentSpcOpenings,
	recordRecentSpcOpening,
	recordSpcThreadCommentActivity,
	readSpcDebugSnapshot,
	runSpcCoverage,
	runSpcCoverageForDay,
	runSpcDay1Coverage,
	evaluateSpcCoverageIntentForDay,
	evaluateSpcCoverageIntents,
	normalizeSpcMinRiskLevel,
	selectSpcPrimaryRiskArea,
	spcSummaryOverlapStates,
	selectAfdOfficesForSpcRegion,
	extractAfdSignalFromText,
	buildSpcAfdEnrichment,
	validateSpcLlmOutput,
	runCoordinatedFacebookCoverage,
	readFacebookCoordinatorSnapshot,
	selectFacebookCoverageIntent,
};

// ---------------------------------------------------------------------------
// Exported worker — fetch + scheduled handlers
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Static image assets — serve from ASSETS binding with candidate path fallback
		const isImageAsset = url.pathname === '/favicon.ico'
			|| url.pathname.startsWith('/images/')
			|| /\.(png|jpe?g|svg|webp|gif)$/i.test(url.pathname);
		if (isImageAsset) {
			if (env.ASSETS) {
				try {
					const candidatePaths = new Set<string>();
					candidatePaths.add(url.pathname);

					if (url.pathname.startsWith('/images/')) {
						candidatePaths.add(url.pathname.replace('/images', '') || '/');
					} else {
						candidatePaths.add('/images' + url.pathname);
					}

					const hashStripped = url.pathname.replace(/\.([a-f0-9]{8,})\.(jpe?g|png|svg|webp|gif)$/i, '.$2');
					if (hashStripped !== url.pathname) {
						candidatePaths.add(hashStripped);
						if (hashStripped.startsWith('/images/')) {
							candidatePaths.add(hashStripped.replace('/images', '') || '/');
						} else {
							candidatePaths.add('/images' + hashStripped);
						}
					}

					for (const path of candidatePaths) {
						const candidateUrl = new URL(request.url);
						candidateUrl.pathname = path;
						const candidateRes = await env.ASSETS.fetch(new Request(candidateUrl.toString(), request));
						if (candidateRes && candidateRes.status !== 404) {
							return candidateRes;
						}
					}
				} catch {
					// fallback to normal handler
				}
			}
		}

		// CORS preflight
		if (request.method === 'OPTIONS') {
			if (url.pathname === '/api/debug/summary') {
				return new Response(null, {
					status: 204,
					headers: debugCorsHeaders(request.headers.get('Origin')),
				});
			}
			if (url.pathname.startsWith('/api/push/')) {
				return new Response(null, {
					status: 204,
					headers: pushCorsHeaders(request.headers.get('Origin')),
				});
			}
			if (url.pathname.startsWith('/api/')) {
				return new Response(null, {
					status: 204,
					headers: apiCorsHeaders(request.headers.get('Origin')),
				});
			}
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}

		// Redirect legacy app paths
		if (request.method === 'GET') {
			if (url.pathname === '/alerts' || url.pathname === '/alerts/') {
				return redirectToCanonicalAppUrl(
					request,
					canonicalAlertsPageUrl(url.searchParams.get('state')),
				);
			}
			if (url.pathname.startsWith('/alerts/')) {
				const rawAlertId = url.pathname.slice('/alerts/'.length).replace(/\/+$/, '');
				if (!rawAlertId) {
					return redirectToCanonicalAppUrl(request, canonicalAlertsPageUrl());
				}
				let alertId = rawAlertId;
				try {
					alertId = decodeURIComponent(rawAlertId);
				} catch {
					alertId = rawAlertId;
				}
				return redirectToCanonicalAppUrl(request, canonicalAlertDetailUrl(alertId));
			}
			if (url.pathname === '/settings' || url.pathname === '/settings/') {
				return redirectToCanonicalAppUrl(request, canonicalSettingsUrl());
			}
		}

		// SPA root
		if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET') {
			return await servePublicAppIndex(request, env);
		}
		if (url.pathname === '/live-weather-alerts' && request.method === 'GET') {
			return await servePublicAppIndex(request, env);
		}
		if ((url.pathname === '/live' || url.pathname === '/live/') && request.method === 'GET') {
			return await servePublicAppIndex(request, env);
		}

		// Public alert APIs
		if (url.pathname === '/api/alerts' && request.method === 'GET') {
			return await handleApiAlerts(request, env);
		}
		if (url.pathname === '/api/alerts/changes' && request.method === 'GET') {
			return await handleApiAlertChanges(request, env);
		}
		if (url.pathname === '/api/alerts/history' && request.method === 'GET') {
			return await handleApiAlertHistory(request, env);
		}
		if (url.pathname === '/api/debug/summary' && request.method === 'GET') {
			return await handleApiDebugSummary(request, env);
		}
		if (url.pathname.startsWith('/api/alerts/') && request.method === 'GET') {
			const rawAlertId = url.pathname.slice('/api/alerts/'.length);
			let alertId = rawAlertId;
			try {
				alertId = decodeURIComponent(rawAlertId);
			} catch {
				alertId = rawAlertId;
			}
			if (!alertId) {
				return new Response(JSON.stringify({ error: 'Alert not found.' }), {
					status: 404,
					headers: {
						...corsHeaders(),
						'Content-Type': 'application/json; charset=utf-8',
						'Cache-Control': 'no-store',
					},
				});
			}
			return await handleApiAlertDetail(request, env, alertId);
		}

		// Geocode / location / weather / radar
		if (url.pathname === '/api/geocode' && request.method === 'GET') {
			return await handleApiGeocode(request);
		}
		if (url.pathname === '/api/location' && request.method === 'GET') {
			return await handleApiLocation(request);
		}
		if (url.pathname === '/api/weather' && request.method === 'GET') {
			return await handleApiWeather(request);
		}
		if (url.pathname === '/api/radar' && request.method === 'GET') {
			return await handleApiRadar(request);
		}

		// Push notification APIs
		if (url.pathname === '/api/push/public-key' && request.method === 'GET') {
			return await handlePushPublicKey(env);
		}
		if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
			return await handlePushSubscribe(request, env);
		}
		if (url.pathname === '/api/push/test' && request.method === 'POST') {
			return await handlePushTest(request, env);
		}
		if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
			return await handlePushUnsubscribe(request, env);
		}

		// Admin
		if (url.pathname === '/admin' && request.method === 'GET') {
			return await handleAdminPage(request, env);
		}
		if (url.pathname === '/admin/login' && request.method === 'POST') {
			return await handleAdminLogin(request, env);
		}
		if (url.pathname === '/admin/post' && request.method === 'POST') {
			return await handlePost(request, env);
		}
		if (url.pathname === '/admin/thread-check' && request.method === 'GET') {
			return await handleThreadCheck(request, env);
		}
		if (url.pathname === '/admin/forecast-data' && request.method === 'GET') {
			return await handleAdminForecastData(request, env);
		}
		if (url.pathname === '/admin/discussions-data' && request.method === 'GET') {
			return await handleAdminDiscussionData(request, env);
		}
		if (url.pathname === '/admin/convective-outlook-data' && request.method === 'GET') {
			return await handleAdminConvectiveOutlookData(request, env);
		}
		if (url.pathname === '/admin/token-exchange' && request.method === 'POST') {
			return await handleTokenExchange(request, env, isAuthenticated, parseRequestBody);
		}
		if (url.pathname === '/admin/token-config' && request.method === 'POST') {
			return await handleTokenConfig(request, env, isAuthenticated, parseRequestBody);
		}
		if (url.pathname === '/admin/auto-post-config' && request.method === 'POST') {
			return await handleAutoPostConfig(request, env, isAuthenticated, parseRequestBody);
		}

		// Static asset catch-all
		if (request.method === 'GET') {
			const assetResponse = await serveStaticAsset(request, env);
			if (assetResponse) {
				return assetResponse;
			}
		}

		return new Response('Not found', { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduled(env));
	},
} satisfies ExportedHandler<Env>;

