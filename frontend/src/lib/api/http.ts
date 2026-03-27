type RequestJsonOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  fallbackError: string;
};

export function getApiBase(): string {
  const configured = (import.meta.env.VITE_ALERTS_API_BASE ?? "").trim();
  if (!configured) return "";
  return configured.replace(/\/+$/, "");
}

export function buildApiUrl(path: string): string {
  const base = getApiBase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export async function requestJson<T>(
  path: string,
  options: RequestJsonOptions
): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    signal: options.signal
  });

  const raw = await response.text();
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const looksLikeHtml = /^\s*</.test(raw);
  if (!contentType.includes("application/json") || looksLikeHtml) {
    throw new Error(options.fallbackError);
  }

  let payload: any;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(options.fallbackError);
  }

  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "";
    if (message) {
      throw new Error(message);
    }
    throw new Error(options.fallbackError);
  }

  return payload as T;
}
