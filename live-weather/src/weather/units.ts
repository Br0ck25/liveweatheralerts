export function measurementValue(measurement: any): number | null {
	const value = Number(measurement?.value);
	return Number.isFinite(value) ? value : null;
}

export function unitCode(measurement: any): string {
	return String(measurement?.unitCode || '').toLowerCase();
}

export function firstFinite(...values: Array<number | null | undefined>): number | null {
	for (const value of values) {
		if (Number.isFinite(value as number)) return Number(value);
	}
	return null;
}

export function roundTo(value: number | null, decimals: number): number | null {
	if (!Number.isFinite(value as number)) return null;
	const factor = Math.pow(10, decimals);
	return Math.round((value as number) * factor) / factor;
}

export function celsiusToFahrenheit(value: number): number {
	return (value * 9) / 5 + 32;
}

export function kmhToMph(value: number): number {
	return value * 0.621371;
}

export function mpsToMph(value: number): number {
	return value * 2.236936;
}

export function knotsToMph(value: number): number {
	return value * 1.15078;
}

export function metersToMiles(value: number): number {
	return value * 0.000621371;
}

export function pascalsToInHg(value: number): number {
	return value * 0.0002952998751;
}

export function toTemperatureF(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('degf')) return value;
	if (unit.includes('degc')) return celsiusToFahrenheit(value);
	return value;
}

export function toSpeedMph(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('mi_h-1') || unit.includes('mph')) return value;
	if (unit.includes('km_h-1')) return kmhToMph(value);
	if (unit.includes('m_s-1')) return mpsToMph(value);
	if (unit.includes('knot') || unit.includes('kt')) return knotsToMph(value);
	return value;
}

export function toPressureInHg(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('hpa')) return pascalsToInHg(value * 100);
	if (unit.includes('pa')) return pascalsToInHg(value);
	if (unit.includes('inhg')) return value;
	return value;
}

export function toMiles(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.endsWith(':m') || unit === 'wmounit:m' || unit.includes('meter')) return metersToMiles(value);
	if (unit.includes('km')) return value * 0.621371;
	if (unit.includes('mile')) return value;
	return value;
}

export function toPercent(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	return value;
}

export function toCompassDirection(degrees: number | null): string | null {
	if (!Number.isFinite(degrees as number)) return null;
	const value = ((degrees as number) % 360 + 360) % 360;
	const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
	return dirs[Math.round(value / 22.5) % 16];
}

export function parseWindSpeedTextMph(value: string): number | null {
	const text = String(value || '').toLowerCase();
	if (!text) return null;
	const numbers = text.match(/\d+(?:\.\d+)?/g);
	if (!numbers || numbers.length === 0) return null;
	const parsed = numbers
		.map((x) => Number(x))
		.filter((x) => Number.isFinite(x));
	if (parsed.length === 0) return null;
	const avg = parsed.reduce((sum, x) => sum + x, 0) / parsed.length;
	if (text.includes('km')) return kmhToMph(avg);
	if (text.includes('m/s')) return mpsToMph(avg);
	if (text.includes('kt')) return knotsToMph(avg);
	return avg;
}

export function forecastTemperatureToF(period: any): number | null {
	const raw = Number(period?.temperature);
	if (!Number.isFinite(raw)) return null;
	const unit = String(period?.temperatureUnit || '').toUpperCase();
	if (unit === 'F' || !unit) return raw;
	if (unit === 'C') return celsiusToFahrenheit(raw);
	return raw;
}

export function severityFromForecastText(text: string): 'high' | 'medium' | 'low' {
	const value = String(text || '').toLowerCase();
	if (/(severe|tornado|flash flood|hurricane|blizzard|thunderstorm|damaging)/i.test(value)) return 'high';
	if (/(rain|showers|wind|snow|sleet|ice|storm|fog|heat)/i.test(value)) return 'medium';
	return 'low';
}
