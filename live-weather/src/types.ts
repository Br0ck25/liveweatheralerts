import type { PushSubscription as WebPushSubscription } from '@block65/webcrypto-web-push';

export interface Env {
	WEATHER_KV: KVNamespace;
	FB_PAGE_ID?: string;
	FB_PAGE_ACCESS_TOKEN?: string;
	ADMIN_PASSWORD?: string;
	DEBUG_SUMMARY_BEARER_TOKEN?: string;
	FB_IMAGE_BASE_URL?: string;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	ASSETS?: {
		fetch(request: Request): Promise<Response>;
	};
}

export interface AlertThread {
	postId: string;       // Facebook post ID to comment on
	nwsAlertId: string;   // NWS alert ID that created this thread
	expiresAt: number;    // Unix timestamp (seconds) — used to prune stale threads
	county: string;       // areaDesc
	alertType: string;    // properties.event
	updateCount: number;  // number of update comments posted on this anchor post (0-based)
	lastPostedAt?: string | null;
	lastPostedSnapshot?: AlertPostedSnapshot | null;
}

export type AlertPostedSnapshot = {
	areaDesc: string;
	expires: string;
	severity: string;
	headline: string;
	description: string;
	instruction: string;
};

export interface FbAppConfig {
	appId?: string;
	appSecret?: string;
}

export type FbAutoPostMode = 'off' | 'tornado_only' | 'smart_high_impact';

export interface FbAutoPostConfig {
	mode: FbAutoPostMode;
	updatedAt: string | null;
}

export type MetroAllowlistEntry = {
	id: string;
	name: string;
	countyFips: string[];
};

export type FacebookAutoPostDecision = {
	eligible: boolean;
	threadAction: FacebookPublishThreadAction;
	reason: string;
	mode: FbAutoPostMode;
	matchedMetroNames: string[];
	countyCount: number;
};

export type AutoPostEvaluationRecord = {
	feature: any;
	change: AlertChangeRecord;
	decision: FacebookAutoPostDecision;
	event: string;
	matchedMetroNames: string[];
	countyCount: number;
};

export type AdminFacebookPostRankBucket = 'post_now' | 'fallback_pick' | 'manual_review' | 'unlikely';

export type AdminFacebookPostRanking = {
	feature: any;
	alertId: string;
	event: string;
	score: number;
	bucket: AdminFacebookPostRankBucket;
	bucketLabel: string;
	reasonCode: string;
	reasonText: string;
	matchedMetroNames: string[];
	countyCount: number;
};

export type FacebookPublishThreadAction = '' | 'new_post' | 'comment';

export type FacebookPublishOptions = {
	request?: Request | null;
	customMessage?: string;
	threadAction?: FacebookPublishThreadAction | string;
	imageUrl?: string;
};

export type FacebookPublishResult = {
	id: string;
	status: 'posted' | 'commented';
	postId: string;
	commentId?: string;
	updateCount?: number;
	chainBreak?: boolean;
};

export interface AdminSessionRecord {
	createdAt: string;
	passwordHash: string;
}

export type PushAlertTypes = {
	warnings: boolean;
	watches: boolean;
	advisories: boolean;
	statements: boolean;
};

export type PushDeliveryScope = 'state' | 'county' | 'radius';
export type PushDeliveryMode = 'immediate' | 'digest';

export type PushQuietHours = {
	enabled: boolean;
	start: string;
	end: string;
};

export type PushScope = {
	id: string;
	placeId?: string | null;
	label: string;
	stateCode: string;
	deliveryScope: PushDeliveryScope;
	countyName?: string | null;
	countyFips?: string | null;
	centerLat?: number | null;
	centerLon?: number | null;
	radiusMiles?: number | null;
	enabled: boolean;
	alertTypes: PushAlertTypes;
	severeOnly: boolean;
};

export type PushPreferences = {
	scopes: PushScope[];
	quietHours: PushQuietHours;
	deliveryMode: PushDeliveryMode;
	pausedUntil?: string | null;
};

export interface PushSubscriptionRecord {
	id: string;
	endpoint: string;
	subscription: WebPushSubscription;
	prefs: PushPreferences;
	indexedStateCodes: string[];
	createdAt: string;
	updatedAt: string;
	userAgent?: string;
}

export type LegacyPushPreferences = {
	stateCode?: string;
	deliveryScope?: PushDeliveryScope;
	countyName?: string | null;
	countyFips?: string | null;
	centerLat?: number | null;
	centerLon?: number | null;
	radiusMiles?: number | null;
	alertTypes?: Partial<PushAlertTypes>;
	quietHours?: Partial<PushQuietHours>;
	severeOnly?: boolean;
	pausedUntil?: string | null;
};

export type LegacyPushSubscriptionRecord = {
	id?: string;
	endpoint?: string;
	stateCode?: string;
	subscription?: WebPushSubscription;
	prefs?: LegacyPushPreferences | PushPreferences;
	indexedStateCodes?: string[];
	createdAt?: string;
	updatedAt?: string;
	userAgent?: string;
};

export type PushStateAlertSnapshot = Record<string, string[]>;

export type AlertImpactCategory =
	| 'tornado'
	| 'flood'
	| 'winter'
	| 'heat'
	| 'wind'
	| 'fire'
	| 'marine'
	| 'coastal'
	| 'air_quality'
	| 'other';

export type AlertChangeType = 'new' | 'updated' | 'extended' | 'expired' | 'all_clear';

export type AlertChangeRecord = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	lat?: number | null;
	lon?: number | null;
	changedAt: string;
	changeType: AlertChangeType;
	severity?: string | null;
	category?: string | null;
	isMajor?: boolean;
	previousExpires?: string | null;
	nextExpires?: string | null;
};

export type AlertLifecycleSnapshotEntry = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	lat?: number | null;
	lon?: number | null;
	headline: string;
	description: string;
	instruction: string;
	severity: string;
	urgency: string;
	certainty: string;
	updated: string;
	expires: string;
	lastChangeType?: Extract<AlertChangeType, 'new' | 'updated' | 'extended'> | null;
	lastChangedAt?: string | null;
};

export type AlertLifecycleSnapshot = Record<string, AlertLifecycleSnapshotEntry>;

export type AlertLifecycleDiffResult = {
	currentSnapshot: AlertLifecycleSnapshot;
	changes: AlertChangeRecord[];
	isInitialSnapshot: boolean;
};

export type AlertHistoryEntry = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	changedAt: string;
	changeType: AlertChangeType;
	severity: string;
	category: string;
	isMajor: boolean;
	summary: string;
	previousExpires?: string | null;
	nextExpires?: string | null;
};

export type AlertHistorySnapshotCounts = {
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
};

export type AlertHistoryDaySnapshot = {
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
	byState: Record<
		string,
		AlertHistorySnapshotCounts
	>;
	byStateCounty?: Record<string, AlertHistorySnapshotCounts>;
};

export type AlertHistoryDayRecord = {
	day: string;
	updatedAt: string;
	snapshot: AlertHistoryDaySnapshot;
	entries: AlertHistoryEntry[];
};

export type AlertHistoryByDay = Record<string, AlertHistoryDayRecord>;

export type PushFailureDiagnostic = {
	at: string;
	stateCode: string;
	subscriptionId?: string | null;
	status?: number;
	message: string;
};

export type OperationalDiagnostics = {
	lastSyncAttemptAt: string | null;
	lastSuccessfulSyncAt: string | null;
	lastSyncError: string | null;
	lastKnownAlertCount: number;
	lastStaleDataAt: string | null;
	lastStaleMinutes: number | null;
	invalidSubscriptionCount: number;
	lastInvalidSubscriptionAt: string | null;
	lastInvalidSubscriptionReason: string | null;
	pushFailureCount: number;
	recentPushFailures: PushFailureDiagnostic[];
};

export interface SavedLocation {
	lat: number;
	lon: number;
	city?: string;
	state?: string;
	zip?: string;
	county?: string;
	countyCode?: string;
	zoneCode?: string;
	label: string;
}

export type AdminForecastLocationConfig = {
	id: string;
	label: string;
	region: string;
	zip: string;
	discussionOfficeCode: string;
	discussionOfficeLabel: string;
};

export type AdminConvectiveOutlookConfig = {
	id: string;
	label: string;
	pageUrl: string;
	imagePrefix: string;
};

export type LifecyclePushEntry = {
	change: AlertChangeRecord;
	feature?: any;
};

export class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// MapClickPeriodOverride type (used by weather/api module)
export type MapClickPeriodOverride = {
	name: string;
	startMs: number;
	shortForecast: string;
	detailedForecast: string;
	precipitationChance: number | null;
	icon: string;
};

// RadarFrame / RadarPayload types (used by weather/api module)
export type RadarFrame = {
	time: string;
	label: string;
};

export type RadarPayload = {
	station: string | null;
	loopImageUrl: string | null;
	stillImageUrl: string | null;
	updated: string;
	summary: string;
	frames: RadarFrame[];
	tileTemplate: string | null;
	hasLiveTiles: boolean;
	defaultCenter: {
		lat: number;
		lon: number;
	};
	defaultZoom: number;
};
