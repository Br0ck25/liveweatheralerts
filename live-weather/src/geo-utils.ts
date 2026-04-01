export function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const earthRadiusMiles = 3958.8;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2
		+ Math.cos((lat1 * Math.PI) / 180)
			* Math.cos((lat2 * Math.PI) / 180)
			* Math.sin(dLon / 2) ** 2;
	return earthRadiusMiles * 2 * Math.asin(Math.sqrt(a));
}

export function parseLonLatCoordinate(candidate: any): [number, number] | null {
	if (!Array.isArray(candidate) || candidate.length < 2) return null;
	const lon = Number(candidate[0]);
	const lat = Number(candidate[1]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
	return [lon, lat];
}

export function normalizeCoordinateSequence(coordinates: any, closeLoop = false): Array<[number, number]> {
	if (!Array.isArray(coordinates)) return [];
	const sequence = coordinates
		.map((candidate) => parseLonLatCoordinate(candidate))
		.filter((pair): pair is [number, number] => Boolean(pair));
	if (
		closeLoop
		&& sequence.length > 1
		&& (sequence[0][0] !== sequence[sequence.length - 1][0] || sequence[0][1] !== sequence[sequence.length - 1][1])
	) {
		sequence.push(sequence[0]);
	}
	return sequence;
}

function projectPointToLocalMiles(
	originLat: number,
	originLon: number,
	targetLat: number,
	targetLon: number,
): { x: number; y: number } {
	const meanLatRadians = (((originLat + targetLat) / 2) * Math.PI) / 180;
	return {
		x: (targetLon - originLon) * 69.172 * Math.cos(meanLatRadians),
		y: (targetLat - originLat) * 69.0,
	};
}

function distancePointToSegmentMiles(
	point: { x: number; y: number },
	start: { x: number; y: number },
	end: { x: number; y: number },
): number {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (dx === 0 && dy === 0) {
		return Math.hypot(point.x - start.x, point.y - start.y);
	}
	const t = Math.max(
		0,
		Math.min(
			1,
			((point.x - start.x) * dx + (point.y - start.y) * dy) / ((dx ** 2) + (dy ** 2)),
		),
	);
	const projection = {
		x: start.x + (dx * t),
		y: start.y + (dy * t),
	};
	return Math.hypot(point.x - projection.x, point.y - projection.y);
}

export function isPointInLinearRing(lat: number, lon: number, ringCoordinates: any): boolean {
	const ring = normalizeCoordinateSequence(ringCoordinates, true);
	if (ring.length < 4) return false;
	let inside = false;
	for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
		const [xi, yi] = ring[index];
		const [xj, yj] = ring[previous];
		const intersects =
			((yi > lat) !== (yj > lat))
			&& (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
		if (intersects) inside = !inside;
	}
	return inside;
}

function minDistanceToCoordinateSequenceMiles(
	lat: number,
	lon: number,
	coordinates: any,
	closeLoop = false,
): number {
	const sequence = normalizeCoordinateSequence(coordinates, closeLoop);
	if (sequence.length === 0) return Number.POSITIVE_INFINITY;
	if (sequence.length === 1) {
		return haversineDistanceMiles(lat, lon, sequence[0][1], sequence[0][0]);
	}
	const origin = { x: 0, y: 0 };
	let minDistance = Number.POSITIVE_INFINITY;
	for (let index = 1; index < sequence.length; index += 1) {
		const start = projectPointToLocalMiles(lat, lon, sequence[index - 1][1], sequence[index - 1][0]);
		const end = projectPointToLocalMiles(lat, lon, sequence[index][1], sequence[index][0]);
		minDistance = Math.min(minDistance, distancePointToSegmentMiles(origin, start, end));
	}
	return minDistance;
}

function minDistanceToPolygonMiles(lat: number, lon: number, polygonCoordinates: any): number {
	const rings = Array.isArray(polygonCoordinates) ? polygonCoordinates : [];
	const outerRing = rings[0];
	if (outerRing && isPointInLinearRing(lat, lon, outerRing)) {
		const insideHole = rings.slice(1).some((ring) => isPointInLinearRing(lat, lon, ring));
		if (!insideHole) return 0;
	}
	let minDistance = Number.POSITIVE_INFINITY;
	for (const ring of rings) {
		minDistance = Math.min(minDistance, minDistanceToCoordinateSequenceMiles(lat, lon, ring, true));
	}
	return minDistance;
}

export function minDistanceToGeometryMiles(lat: number, lon: number, geometry: any): number {
	if (!geometry || typeof geometry !== 'object') return Number.POSITIVE_INFINITY;
	switch (String(geometry.type || '')) {
		case 'Point':
			return minDistanceToCoordinateSequenceMiles(lat, lon, [geometry.coordinates]);
		case 'MultiPoint':
		case 'LineString':
			return minDistanceToCoordinateSequenceMiles(lat, lon, geometry.coordinates);
		case 'MultiLineString': {
			const parts = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
			return parts.reduce(
				(minDistance: number, part: any) => Math.min(minDistance, minDistanceToCoordinateSequenceMiles(lat, lon, part)),
				Number.POSITIVE_INFINITY,
			);
		}
		case 'Polygon':
			return minDistanceToPolygonMiles(lat, lon, geometry.coordinates);
		case 'MultiPolygon': {
			const polygons = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
			return polygons.reduce(
				(minDistance: number, polygon: any) => Math.min(minDistance, minDistanceToPolygonMiles(lat, lon, polygon)),
				Number.POSITIVE_INFINITY,
			);
		}
		case 'GeometryCollection': {
			const geometries = Array.isArray(geometry.geometries) ? geometry.geometries : [];
			return geometries.reduce(
				(minDistance: number, child: any) => Math.min(minDistance, minDistanceToGeometryMiles(lat, lon, child)),
				Number.POSITIVE_INFINITY,
			);
		}
		default:
			return Number.POSITIVE_INFINITY;
	}
}

export function alertIntersectsRadius(feature: any, lat: number, lon: number, radiusMiles: number): boolean {
	if (!(radiusMiles > 0) || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
	const geometryDistance = minDistanceToGeometryMiles(lat, lon, feature?.geometry);
	if (Number.isFinite(geometryDistance)) {
		return geometryDistance <= radiusMiles;
	}
	const location = centroidFromGeometry(feature);
	if (Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
		return haversineDistanceMiles(lat, lon, Number(location.lat), Number(location.lon)) <= radiusMiles;
	}
	return false;
}

export function collectGeometryCoordinatePairs(geometry: any): Array<[number, number]> {
	const pairs: Array<[number, number]> = [];
	if (!geometry || typeof geometry !== 'object') return pairs;

	const pushPair = (candidate: any) => {
		if (!Array.isArray(candidate) || candidate.length < 2) return;
		const lon = Number(candidate[0]);
		const lat = Number(candidate[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
		pairs.push([lat, lon]);
	};

	const visit = (node: any) => {
		if (!Array.isArray(node)) return;
		if (node.length >= 2 && typeof node[0] !== 'object' && typeof node[1] !== 'object') {
			pushPair(node);
			return;
		}
		for (const child of node) {
			visit(child);
		}
	};

	visit(geometry.coordinates);
	return pairs;
}

export function centroidFromGeometry(feature: any): { lat?: number; lon?: number } {
	const pairs = collectGeometryCoordinatePairs(feature?.geometry);
	if (pairs.length === 0) return {};
	const [latTotal, lonTotal] = pairs.reduce(
		(acc, [lat, lon]) => [acc[0] + lat, acc[1] + lon],
		[0, 0],
	);
	return {
		lat: Number((latTotal / pairs.length).toFixed(4)),
		lon: Number((lonTotal / pairs.length).toFixed(4)),
	};
}
