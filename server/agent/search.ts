// The web_search tool: the only file that calls Tavily. The model names the
// entities to check and a few queries for each; code fans them out into
// searches, runs them in parallel with a timeout each, then merges, ranks
// and dates what comes back, so one slow or failed search never sinks the rest.
import { z } from "zod";
import type { Evidence } from "../../shared/types.ts";
import {
  MAX_EVIDENCE_PER_ENTITY,
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
 * collapsed, cut at a word near SNIPPET_MAX_CHARS. It stays data; the model
 * is told never to follow instructions in it.
 */
export function cleanText(text: string): string {
  // \u0000-\u001f are the control characters, \u007f is DEL.
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX_CHARS) return flat;
  const cut = flat.slice(0, SNIPPET_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SNIPPET_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
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
// The tool

export interface WebSearchOptions {
  apiKey: string;
  /** Injected so tests can stand in for Tavily. */
  fetch?: Fetch;
  now?: () => Date;
  /** Per-search timeout; tests shorten it. */
  timeoutMs?: number;
}

export function createWebSearch(options: WebSearchOptions): WebSearch {
  const context: SearchContext = {
    apiKey: options.apiKey,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
  };
  const now = options.now ?? (() => new Date());

  return {
    async search(input, signal) {
      const searchedAt = now().toISOString();
      const planned = planSearches(input);
      // All at once: the slowest search sets the time, not the sum of them.
      const outcomes = await Promise.all(planned.map((search) => runSearch(context, search, signal)));

      const entities: EntityResult[] = input.entities.map((entity, index) => {
        const mine = outcomes.filter((_, at) => planned[at]?.entity === index);
        const found = mine.flatMap((outcome) => (outcome.ok ? outcome.results : []));
        const failures = mine.flatMap((outcome) => (outcome.ok ? [] : [outcome.failure]));
        const evidence = mergeEntity(entity, found);

        if (failures.length === mine.length) {
          return { entity: entity.name, status: "failed", failure: mostTelling(failures), evidence: [] };
        }
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
