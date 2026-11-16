// The web_search tool: the only file that calls Tavily. The model names the
// entities to check and a few queries for each; code fans them out into
// searches, runs them in parallel with a timeout each, then merges, ranks
// and dates what comes back, so one slow or failed search never sinks the rest.
// Then it reads each entity's own pricing or changelog page, which beats any
// third-party summary of it.
import { z } from "zod";
import type { Evidence } from "../../shared/types.ts";
import {
  EXTRACT_CHUNKS,
  EXTRACT_DEPTH,
  EXTRACT_TIMEOUT_MS,
  EXTRACT_TIMEOUT_S,
  EXTRACT_URL,
  MAX_EVIDENCE_PER_ENTITY,
  PAGE_MAX_CHARS,
  PAGES_PER_ENTITY,
  MAX_PARALLEL_SEARCHES,
  MAX_SEARCH_ENTITIES,
  SEARCH_RESULTS_PER_QUERY,
  SEARCH_TIMEOUT_MS,
  SEARCH_URL,
  SNIPPET_MAX_CHARS,
} from "../config.ts";

// ---------------------------------------------------------------------------
// Input: validated here and given to the model as the tool's schema

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export const webSearchInput = z
  .object({
    entities: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100).describe('What to check, e.g. "HubSpot" or "Postgres".'),
            queries: z
              .array(z.string().trim().min(2).max(200))
              .min(1)
              .max(3)
              .describe('1 to 3 search queries for this entity, most important first, e.g. "HubSpot CRM pricing per seat".'),
            officialSite: z
              .string()
              .trim()
              .regex(HOSTNAME)
              .optional()
              .describe('The entity\'s own website, e.g. "hubspot.com", when known. Its pages are preferred.'),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SEARCH_ENTITIES)
      .describe(`The things to check, one entry each, at most ${MAX_SEARCH_ENTITIES}.`),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("YYYY-MM-DD. Look for changes announced after this date, e.g. the date of the record being re-checked."),
  })
  .strict();

export type WebSearchInput = z.infer<typeof webSearchInput>;

/** The tool as the model sees it (OpenAI function format). */
export const WEB_SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description:
      "Search the web for the current state of one or more things: prices, versions, availability, or whether something is still true. Each entity's queries run in parallel with a news search for announced changes. Returns dated sources per entity.",
    parameters: toolSchema(),
  },
};

function toolSchema(): { [key: string]: unknown } {
  // The "$schema" line is dropped: not every API accepts it.
  const { $schema: _dropped, ...schema } = z.toJSONSchema(webSearchInput);
  return schema;
}

// ---------------------------------------------------------------------------
// Output

/** Why a single search did not return results. */
export type SearchFailure =
  | "timeout"
  /** Too many searches too quickly. */
  | "rate_limited"
  /** The plan's usage limit is reached. */
  | "quota"
  /** The Tavily key is missing or rejected. */
  | "auth"
  /** Anything else: a server error, a network failure, an unreadable reply. */
  | "failed";

export interface EntityResult {
  entity: string;
  /** "failed" only when every search for this entity failed; "no_results" when they ran but found nothing. */
  status: "found" | "no_results" | "failed";
  /** For "failed": the reason. For "found": set when some of the entity's searches failed. */
  failure?: SearchFailure;
  evidence: Evidence[];
}

export interface WebSearchResult {
  /** When the search ran, ISO 8601. Sources are as of this moment. */
  searchedAt: string;
  /** Set when no search could run at all, so the answer says search is unavailable. */
  unavailable?: "rate_limited" | "quota" | "auth";
  entities: EntityResult[];
}

export interface WebSearch {
  search(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
}

// ---------------------------------------------------------------------------
// Fan-out

interface PlannedSearch {
  /** Index into input.entities. */
  entity: number;
  query: string;
  topic: "general" | "news";
  startDate?: string;
  /** Only pages on these sites: finding the entity's own pricing or changelog page. */
  includeDomains?: string[];
}

/**
 * Turns the model's request into at most MAX_PARALLEL_SEARCHES searches.
 * Every entity first gets its main query, then a news search for announced
 * changes, then its other queries, taking turns so no entity is left out
 * when the budget runs short.
 */
export function planSearches(input: WebSearchInput): PlannedSearch[] {
  const rounds: PlannedSearch[][] = [];
  input.entities.forEach((entity, index) => {
    const [main, ...rest] = entity.queries;
    const own: PlannedSearch[] = [];
    if (main !== undefined) own.push({ entity: index, query: main, topic: "general" });
    if (main !== undefined) {
      const news: PlannedSearch = { entity: index, query: main, topic: "news" };
      if (input.since !== undefined) news.startDate = input.since;
      own.push(news);
    }
    for (const query of rest) own.push({ entity: index, query, topic: "general" });
    own.forEach((search, turn) => {
      (rounds[turn] ??= []).push(search);
    });
  });
  return rounds.flat().slice(0, MAX_PARALLEL_SEARCHES);
}

// ---------------------------------------------------------------------------
// One search

// Only the fields used are checked; Tavily may add others.
const tavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      score: z.number().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

interface Found {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate: string | null;
}

type Outcome = { ok: true; results: Found[] } | { ok: false; failure: SearchFailure };

type Fetch = typeof fetch;

interface SearchContext {
  apiKey: string;
  fetch: Fetch;
  timeoutMs: number;
  extractTimeoutMs: number;
}

async function runSearch(context: SearchContext, planned: PlannedSearch, signal: AbortSignal | undefined): Promise<Outcome> {
  const timeout = AbortSignal.timeout(context.timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await context.fetch(SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${context.apiKey}` },
      body: JSON.stringify({
        query: planned.query,
        topic: planned.topic,
        search_depth: "basic",
        max_results: SEARCH_RESULTS_PER_QUERY,
        // Dated sources are what "has it changed since" needs. Undated
        // results are kept and marked, not dropped.
        include_published_date: true,
        ...(planned.startDate === undefined ? {} : { start_date: planned.startDate }),
        ...(planned.includeDomains === undefined ? {} : { include_domains: planned.includeDomains }),
      }),
      signal: combined,
    });
    if (!response.ok) return { ok: false, failure: failureForStatus(response.status) };
    const parsed = tavilyResponse.safeParse(await response.json());
    if (!parsed.success) return { ok: false, failure: "failed" };
    return {
      ok: true,
      results: parsed.data.results.map((result) => ({
        title: cleanText(result.title ?? "") || result.url,
        url: result.url,
        content: result.content ?? "",
        score: result.score ?? 0,
        publishedDate: toDay(result.published_date ?? null),
      })),
    };
  } catch {
    // An abort from our own timer is a timeout; anything else (a network
    // failure, unreadable JSON, the user stopping) cannot be retried here.
    return { ok: false, failure: timeout.aborted ? "timeout" : "failed" };
  }
}

function failureForStatus(status: number): SearchFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 434) return "rate_limited";
  if (status === 432 || status === 433) return "quota";
  return "failed";
}

// ---------------------------------------------------------------------------
// Merge, rank, date

/** A URL reduced to what identifies the page: no "www.", fragment, tracking parameters or trailing slash. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...parsed.searchParams.entries()]
      .filter(([name]) => !/^(utm_|ref$|fbclid$|gclid$)/i.test(name))
      .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${query}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Whether a page is on the entity's own site: the official site the model
 * gave, or otherwise a host with the entity's first word as one of its
 * labels ("zoho" for "Zoho CRM" matches www.zoho.com but not zohoreview.net).
 */
export function isOfficial(site: string, entity: { name: string; officialSite?: string | undefined }): boolean {
  if (site === "") return false;
  if (entity.officialSite !== undefined) {
    const official = entity.officialSite.toLowerCase().replace(/^www\./, "");
    return site === official || site.endsWith(`.${official}`);
  }
  const word = entity.name.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, "") ?? "";
  return word.length >= 3 && site.split(".").includes(word);
}

/** YYYY-MM-DD from Tavily's date ("Tue, 11 Mar 2025 17:00:00 GMT" or ISO), or null. */
export function toDay(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/**
 * Page text as plain, short text: control characters out, whitespace
 * collapsed, cut at a word near `maxChars`. It stays data; the model is told
 * never to follow instructions in it.
 */
export function cleanText(text: string, maxChars = SNIPPET_MAX_CHARS): string {
  // \u0000-\u001f are the control characters, \u007f is DEL.
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function mergeEntity(entity: WebSearchInput["entities"][number], found: Found[]): Evidence[] {
  const byPage = new Map<string, Found>();
  for (const result of found) {
    const key = pageKey(result.url);
    const seen = byPage.get(key);
    if (seen === undefined) {
      byPage.set(key, { ...result });
      continue;
    }
    // The same page from two searches: keep its best score and any date either found.
    seen.score = Math.max(seen.score, result.score);
    seen.publishedDate ??= result.publishedDate;
    if (seen.content.length < result.content.length) seen.content = result.content;
  }

  return [...byPage.values()]
    .map((result) => {
      const site = siteOf(result.url);
      return { result, site, official: isOfficial(site, entity) };
    })
    // The entity's own pages first (REQUIREMENTS F14), then Tavily's relevance.
    .sort((a, b) => Number(b.official) - Number(a.official) || b.result.score - a.result.score)
    .slice(0, MAX_EVIDENCE_PER_ENTITY)
    .map(({ result, site, official }) => ({
      title: result.title,
      url: result.url,
      site,
      publishedDate: result.publishedDate,
      snippet: cleanText(result.content),
      official,
    }));
}

// ---------------------------------------------------------------------------
// Reading the entity's own pages

// What a question about an entity is after, read from its queries.
const ASKS_PRICE = /pric|plan|cost|seat|billing|tier|subscription/i;
const ASKS_RELEASES = /release|launch|ship|changelog|feature|update|announce|new\b|what's new/i;
// Where a site keeps that, read from a page's path.
const PRICE_PAGE = /pric|plans?\b|billing/i;
// Not "blog": a vendor's blog is mostly guides ("best CRM software"), not what shipped.
const RELEASE_PAGE = /changelog|release|whats?-new|what-s-new|product-updates|updates|newsroom|\/news\b|announce/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

type Wanted = "price" | "releases";
const WANTED_PAGE: { [want in Wanted]: RegExp } = { price: PRICE_PAGE, releases: RELEASE_PAGE };

/**
 * The entity's own pages worth reading in full, best first: its pricing page
 * for a price question, its changelog or news for "what shipped". `missing`
 * names what the question wants but the search results had no page for.
 */
export function pagesToRead(entity: WebSearchInput["entities"][number], evidence: Evidence[]): { urls: string[]; missing: Wanted[] } {
  const queries = entity.queries.join(" ");
  const wanted: Wanted[] = [...(ASKS_PRICE.test(queries) ? ["price" as const] : []), ...(ASKS_RELEASES.test(queries) ? ["releases" as const] : [])];
  const official = evidence.filter((page) => page.official);
  const urls: string[] = [];
  const missing: Wanted[] = [];
  for (const want of wanted) {
    const url = official.find((page) => WANTED_PAGE[want].test(pathOf(page.url)))?.url;
    if (url === undefined) missing.push(want);
    else urls.push(url);
  }
  // A question that wants neither: the entity's best page of its own.
  if (wanted.length === 0 && official[0] !== undefined) urls.push(official[0].url);
  return { urls: [...new Set(urls)].slice(0, PAGES_PER_ENTITY), missing };
}

/**
 * One search on the entity's own site, for each entity whose site is known
 * and whose question wants prices or releases. They run with the main
 * searches, not after them, and are used only to find the vendor's own
 * pricing or changelog page to read: they are not listed as sources, so
 * they cannot crowd out third-party news.
 */
export function planSiteSearches(input: WebSearchInput): PlannedSearch[] {
  return input.entities.flatMap((entity, index) => {
    const queries = entity.queries.join(" ");
    if (entity.officialSite === undefined || !(ASKS_PRICE.test(queries) || ASKS_RELEASES.test(queries))) return [];
    return [{ entity: index, query: entity.queries[0]!, topic: "general" as const, includeDomains: [entity.officialSite] }];
  });
}

/**
 * The pages to read for one entity: picked from its official search results
 * and its own-site search. A price question with no page called "pricing"
 * takes the own-site search's best match.
 */
function ownPages(entity: WebSearchInput["entities"][number], evidence: Evidence[], onSite: Found[]): string[] {
  const siteEvidence: Evidence[] = onSite.map((result) => ({
    title: result.title,
    url: result.url,
    site: siteOf(result.url),
    publishedDate: result.publishedDate,
    snippet: "",
    official: true,
  }));
  const { urls, missing } = pagesToRead(entity, [...evidence, ...siteEvidence]);
  if (missing.includes("price") && onSite[0] !== undefined) urls.push(onSite[0].url);
  return [...new Set(urls)].slice(0, PAGES_PER_ENTITY);
}

const tavilyExtract = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
});

/**
 * The text of each page that could be read, keyed by page, with only the
 * chunks most relevant to `query`. A failure of any kind returns what was
 * read, or nothing: the search results stand on their own.
 */
async function readPages(context: SearchContext, urls: string[], query: string, signal: AbortSignal | undefined): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  if (urls.length === 0) return pages;
  const timeout = AbortSignal.timeout(context.extractTimeoutMs);
  try {
    const response = await context.fetch(EXTRACT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${context.apiKey}` },
      body: JSON.stringify({
        urls,
        query,
        chunks_per_source: EXTRACT_CHUNKS,
        extract_depth: EXTRACT_DEPTH,
        format: "markdown",
        timeout: EXTRACT_TIMEOUT_S,
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) return pages;
    const parsed = tavilyExtract.safeParse(await response.json());
    if (!parsed.success) return pages;
    for (const page of parsed.data.results) {
      const text = cleanText(page.raw_content ?? "", PAGE_MAX_CHARS);
      if (text !== "") pages.set(pageKey(page.url), text);
    }
  } catch {
    // A timeout, a network failure or Stop: the snippets are still there.
  }
  return pages;
}

/** The entity's evidence with the pages read put first, their text in place of the search snippet. */
function withPagesRead(evidence: Evidence[], urls: string[], pages: Map<string, string>): Evidence[] {
  const read: Evidence[] = [];
  for (const url of urls) {
    const text = pages.get(pageKey(url));
    if (text === undefined) continue;
    const known = evidence.find((page) => pageKey(page.url) === pageKey(url));
    const site = siteOf(url);
    read.push({
      title: known?.title ?? site,
      url: known?.url ?? url,
      site,
      publishedDate: known?.publishedDate ?? null,
      snippet: text,
      official: true,
      readNow: true,
    });
  }
  const readKeys = new Set(read.map((page) => pageKey(page.url)));
  return [...read, ...evidence.filter((page) => !readKeys.has(pageKey(page.url)))];
}

// ---------------------------------------------------------------------------
// The tool

export interface WebSearchOptions {
  apiKey: string;
  /** Injected so tests can stand in for Tavily. */
  fetch?: Fetch;
  now?: () => Date;
  /** Per-search timeout; tests shorten it. */
  timeoutMs?: number;
  /** Timeout for reading pages; tests shorten it. */
  extractTimeoutMs?: number;
}

export function createWebSearch(options: WebSearchOptions): WebSearch {
  const context: SearchContext = {
    apiKey: options.apiKey,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
    extractTimeoutMs: options.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS,
  };
  const now = options.now ?? (() => new Date());

  return {
    async search(input, signal) {
      const searchedAt = now().toISOString();
      const planned = planSearches(input);
      const onSite = planSiteSearches(input);
      // All at once, own-site searches included: the slowest search sets the time, not the sum of them.
      const [outcomes, siteOutcomes] = await Promise.all([
        Promise.all(planned.map((search) => runSearch(context, search, signal))),
        Promise.all(onSite.map((search) => runSearch(context, search, signal))),
      ]);

      const merged = input.entities.map((entity, index) => {
        const mine = outcomes.filter((_, at) => planned[at]?.entity === index);
        const found = mine.flatMap((outcome) => (outcome.ok ? outcome.results : []));
        const failures = mine.flatMap((outcome) => (outcome.ok ? [] : [outcome.failure]));
        return { entity, failures, allFailed: failures.length === mine.length, evidence: mergeEntity(entity, found) };
      });

      // Each entity's own pages, all read at once. Not when its searches all
      // failed: that is a key, quota or network problem a read would share.
      const toRead = merged.map(({ entity, allFailed, evidence }, index) => {
        if (allFailed) return [];
        const found = onSite.flatMap((search, at) => {
          const outcome = siteOutcomes[at];
          return search.entity === index && outcome?.ok === true ? outcome.results : [];
        });
        return ownPages(entity, evidence, found);
      });
      const read = await Promise.all(
        toRead.map((urls, index) => readPages(context, urls, input.entities[index]!.queries[0]!, signal)),
      );

      const entities: EntityResult[] = merged.map(({ entity, failures, allFailed, evidence: found }, index) => {
        if (allFailed) return { entity: entity.name, status: "failed", failure: mostTelling(failures), evidence: [] };
        const evidence = withPagesRead(found, toRead[index]!, read[index]!);
        const result: EntityResult = { entity: entity.name, status: evidence.length > 0 ? "found" : "no_results", evidence };
        if (failures.length > 0) result.failure = mostTelling(failures);
        return result;
      });

      const result: WebSearchResult = { searchedAt, entities };
      const unavailable = searchUnavailable(outcomes);
      if (unavailable !== undefined) result.unavailable = unavailable;
      return result;
    },
  };
}

// When an entity's searches failed for different reasons, report the one
// that tells the user most: a key or quota problem over a passing timeout.
function mostTelling(failures: SearchFailure[]): SearchFailure {
  const order: SearchFailure[] = ["auth", "quota", "rate_limited", "timeout", "failed"];
  return order.find((reason) => failures.includes(reason)) ?? "failed";
}

/** Search as a whole is unavailable when every search failed on the key, the quota or the rate limit. */
function searchUnavailable(outcomes: Outcome[]): WebSearchResult["unavailable"] {
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.failure]));
  if (outcomes.length === 0 || failures.length !== outcomes.length) return undefined;
  if (failures.includes("auth")) return "auth";
  if (failures.every((failure) => failure === "quota" || failure === "rate_limited")) {
    return failures.includes("quota") ? "quota" : "rate_limited";
  }
  return undefined;
}
