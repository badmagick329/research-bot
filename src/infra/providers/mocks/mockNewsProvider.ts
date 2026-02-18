import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import { ok, type Result } from "neverthrow";

/**
 * Supplies repeatable news payloads so ingestion and deduplication logic can be tested in isolation.
 */
export class MockNewsProvider implements NewsProviderPort {
  /**
   * Generates symbol-scoped mock headlines to keep early pipeline development independent from vendor uptime.
   */
  async fetchArticles(
    request: NewsSearchRequest,
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>> {
    const baseDate = request.to;
    const symbol = request.symbol.toUpperCase();

    return ok(
      Array.from({ length: Math.min(5, request.limit) }).map((_, index) => ({
        id: `${symbol}-news-${index}`,
        provider: "mock-news-wire",
        providerItemId: `${symbol}-nw-${baseDate.getTime()}-${index}`,
        title: `${symbol} mock headline ${index + 1}`,
        summary: `${symbol} update focused on margin, demand, and macro context`,
        content: `${symbol} reported simulated developments around product demand, channel checks, and cost controls. This payload mirrors typical provider fields for v0 prototyping.`,
        url: `https://example.local/news/${symbol}/${index}`,
        authors: ["Research Bot"],
        publishedAt: new Date(baseDate.getTime() - index * 60 * 60 * 1000),
        language: "en",
        symbols: [symbol],
        topics: ["earnings", "guidance", "macro"],
        sentiment: index % 2 === 0 ? 0.2 : -0.1,
        sourceType: "api",
        rawPayload: {
          headline: `${symbol} raw headline ${index + 1}`,
          body: "Raw provider body",
          tags: ["equities", symbol],
        },
      })),
    );
  }
}
