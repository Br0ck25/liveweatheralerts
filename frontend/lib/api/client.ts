const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export async function safeJson(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON but received: ${text.slice(0, 120)}`);
  }

  return JSON.parse(text);
}

export async function fetchWeather(lat: number, lon: number) {
  const res = await fetch(
    `${API_BASE}/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
    {
      cache: "no-store",
    }
  );
  const data = await safeJson(res);
  if (!res.ok) {
    throw new Error(data?.error || "Unable to load weather.");
  }
  return data;
}
