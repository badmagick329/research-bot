import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../core/ports/inboundPorts";
import { logger } from "../../shared/logger/logger";

const normalizeUrl = (value: string): string => value.trim().toLowerCase();

/**
 * Aggregates multiple provider adapters so ingestion can keep breadth and remain available during single-vendor outages.
 */
export class MultiNewsProvider implements NewsProviderPort {
  constructor(private readonly providers: NewsProviderPort[]) {
    if (providers.length === 0) {
      throw new Error("MultiNewsProvider requires at least one provider.");
    }
  }

  /**
   * Merges provider responses with URL-based dedupe and degrades gracefully when one source fails.
   */
  async fetchArticles(
    request: NewsSearchRequest,
  ): Promise<NormalizedNewsItem[]> {
    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.fetchArticles(request)),
    );

    const merged: NormalizedNewsItem[] = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        merged.push(...result.value);
        return;
      }

      logger.warn(
        {
          providerIndex: index,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
        "News provider failed; continuing with available sources",
      );
    });

    const dedupedByUrl = new Map<string, NormalizedNewsItem>();
    const withoutUrl: NormalizedNewsItem[] = [];

    merged.forEach((item) => {
      const key = normalizeUrl(item.url);
      if (!key || key.length === 0) {
        withoutUrl.push(item);
        return;
      }

      const existing = dedupedByUrl.get(key);
      if (
        !existing ||
        item.publishedAt.getTime() > existing.publishedAt.getTime()
      ) {
        dedupedByUrl.set(key, item);
      }
    });

    return [...dedupedByUrl.values(), ...withoutUrl]
      .sort(
        (left, right) =>
          right.publishedAt.getTime() - left.publishedAt.getTime(),
      )
      .slice(0, request.limit);
  }
}
