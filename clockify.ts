import { config, requireClockifyApiKey } from "./config.js";

type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue | QueryValue[]>;

type RequestOptions = {
  baseUrl?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
};

export class ClockifyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly responseBody: unknown,
  ) {
    super(`Clockify API error ${status} ${statusText}`);
  }
}

const cleanValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(cleanValue).filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanValue(entryValue)]),
    );
  }

  return value;
};

const appendQuery = (url: URL, query?: Query) => {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];

    for (const entry of values) {
      if (entry === undefined || entry === null || entry === "") {
        continue;
      }

      url.searchParams.append(key, String(entry));
    }
  }
};

export class ClockifyClient {
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const baseUrl = options.baseUrl ?? config.clockifyApiBaseUrl;
    const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
    appendQuery(url, options.query);

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": requireClockifyApiKey(),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(cleanValue(options.body)),
    });

    const responseText = await response.text();
    const responseBody = responseText ? parseResponse(responseText) : null;

    if (!response.ok) {
      throw new ClockifyApiError(
        response.status,
        response.statusText,
        url.toString(),
        responseBody,
      );
    }

    return responseBody as T;
  }

  api<T>(path: string, options: Omit<RequestOptions, "baseUrl"> = {}) {
    return this.request<T>(path, { ...options, baseUrl: config.clockifyApiBaseUrl });
  }

  reports<T>(path: string, options: Omit<RequestOptions, "baseUrl"> = {}) {
    return this.request<T>(path, {
      ...options,
      baseUrl: config.clockifyReportsBaseUrl,
    });
  }

  auditLog<T>(path: string, options: Omit<RequestOptions, "baseUrl"> = {}) {
    return this.request<T>(path, {
      ...options,
      baseUrl: config.clockifyAuditLogBaseUrl,
    });
  }
}

const parseResponse = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
