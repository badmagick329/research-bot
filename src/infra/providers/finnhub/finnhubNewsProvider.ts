import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../../core/ports/inboundPorts";
import { toIsoDate } from "../utils/dateUtils";

type FinnhubNewsItem = {
  category?: string;
  datetime?: number;
  headline?: string;
  id?: number;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
};

/**
 * Translates Finnhub company-news payloads into the app's normalized news contract.
 */
export class FinnhubNewsProvider implements NewsProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "FINNHUB_API_KEY is required when NEWS_PROVIDER is set to finnhub.",
      );
    }
  }

  /**
   * Keeps ingestion resilient by returning an empty dataset when provider responses are unavailable.
   */
  async fetchArticles(
    request: NewsSearchRequest,
  ): Promise<NormalizedNewsItem[]> {
    const url = new URL("/api/v1/company-news", this.baseUrl);
    url.searchParams.set("symbol", request.symbol.toUpperCase());
    url.searchParams.set("from", toIsoDate(request.from));
    url.searchParams.set("to", toIsoDate(request.to));
    url.searchParams.set("token", this.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) {
        return [];
      }

      return payload
        .slice(0, request.limit)
        .map((item, index) =>
          this.toNormalizedItem(request.symbol.toUpperCase(), item, index),
        )
        .filter((item): item is NormalizedNewsItem => item !== null);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Produces stable provider identities so document upserts deduplicate repeat polls.
   */
  private toNormalizedItem(
    symbol: string,
    raw: unknown,
    index: number,
  ): NormalizedNewsItem | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const item = raw as FinnhubNewsItem;
    const title = item.headline?.trim();
    if (!title) {
      return null;
    }

    const providerItemId =
      typeof item.id === "number"
        ? String(item.id)
        : `${symbol}-${item.datetime ?? "na"}-${index}`;

    const relatedSymbols =
      typeof item.related === "string" && item.related.length > 0
        ? item.related
            .split(",")
            .map((value) => value.trim().toUpperCase())
            .filter(Boolean)
        : [symbol];

    if (!relatedSymbols.includes(symbol)) {
      relatedSymbols.push(symbol);
    }

    const publishedAt =
      typeof item.datetime === "number"
        ? new Date(item.datetime * 1000)
        : new Date();

    const summary = item.summary?.trim();

    return {
      id: `finnhub-${providerItemId}`,
      provider: "finnhub",
      providerItemId,
      title,
      summary,
      content: summary && summary.length > 0 ? summary : title,
      url: item.url ?? "",
      authors: item.source ? [item.source] : [],
      publishedAt,
      language: "en",
      symbols: relatedSymbols,
      topics: item.category ? [item.category] : ["market-news"],
      sentiment: undefined,
      sourceType: "api",
      rawPayload: raw,
    };
  }
}
