const DUCKDUCKGO_HTML_SEARCH_URL = "https://duckduckgo.com/html/";
const DEFAULT_WEB_SEARCH_RESULT_LIMIT = 5;
const MAX_WEB_SEARCH_RESULT_LIMIT = 10;
const WEB_SEARCH_USER_AGENT = "ShioriCode/1.0 (+https://shiori.ai/code)";

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export interface ShioriWebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly displayUrl: string;
}

export interface ShioriWebSearchResponse {
  readonly query: string;
  readonly provider: "duckduckgo";
  readonly results: ReadonlyArray<ShioriWebSearchResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, entity) => HTML_ENTITY_MAP[entity.toLowerCase()] ?? match);
}

function stripHtml(value: string): string {
  return normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")));
}

function clampResultLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_WEB_SEARCH_RESULT_LIMIT, Math.round(value)));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_WEB_SEARCH_RESULT_LIMIT, Math.round(parsed)));
    }
  }
  return DEFAULT_WEB_SEARCH_RESULT_LIMIT;
}

function deriveDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function resolveDuckDuckGoResultUrl(rawHref: string): string | null {
  const decodedHref = decodeHtmlEntities(rawHref).trim();
  if (decodedHref.length === 0) {
    return null;
  }

  const absoluteHref = decodedHref.startsWith("//") ? `https:${decodedHref}` : decodedHref;
  try {
    const parsed = new URL(absoluteHref, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    const candidate = redirected ?? parsed.toString();
    const resultUrl = new URL(candidate);
    if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") {
      return null;
    }
    return resultUrl.toString();
  } catch {
    return null;
  }
}

function extractQuery(input: Record<string, unknown>): string {
  const rawQuery =
    typeof input.query === "string"
      ? input.query
      : typeof input.q === "string"
        ? input.q
        : typeof input.search === "string"
          ? input.search
          : "";
  const query = rawQuery.trim();
  if (query.length === 0) {
    throw new Error("Web search requires a non-empty query.");
  }
  return query;
}

export function parseDuckDuckGoHtmlSearchResults(
  html: string,
  maxResults = DEFAULT_WEB_SEARCH_RESULT_LIMIT,
): ReadonlyArray<ShioriWebSearchResult> {
  const results: ShioriWebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const blocks =
    html.match(/<div class="result\b[\s\S]*?<div class="clear"><\/div>\s*<\/div>\s*<\/div>/g) ?? [];

  for (const block of blocks) {
    const titleMatch = block.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!titleMatch?.[1] || !titleMatch[2]) {
      continue;
    }

    const url = resolveDuckDuckGoResultUrl(titleMatch[1]);
    if (!url || seenUrls.has(url)) {
      continue;
    }

    const title = stripHtml(titleMatch[2]);
    if (title.length === 0) {
      continue;
    }

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const displayUrlMatch = block.match(/<a[^>]*class="result__url"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch?.[1] ? stripHtml(snippetMatch[1]) : "";
    const displayUrl = displayUrlMatch?.[1] ? stripHtml(displayUrlMatch[1]) : deriveDisplayUrl(url);

    results.push({
      title,
      url,
      snippet,
      displayUrl,
    });
    seenUrls.add(url);

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

export async function executeShioriWebSearch(input: {
  readonly toolInput: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}): Promise<ShioriWebSearchResponse> {
  const query = extractQuery(input.toolInput);
  const maxResults = clampResultLimit(input.toolInput.max_results ?? input.toolInput.maxResults);
  const fetchImpl = input.fetchImpl ?? fetch;
  const searchUrl = new URL(DUCKDUCKGO_HTML_SEARCH_URL);
  searchUrl.searchParams.set("q", query);

  const response = await fetchImpl(searchUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": WEB_SEARCH_USER_AGENT,
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Web search failed with ${response.status} ${response.statusText}`.trim());
  }

  const html = await response.text();
  return {
    query,
    provider: "duckduckgo",
    results: parseDuckDuckGoHtmlSearchResults(html, maxResults),
  };
}
