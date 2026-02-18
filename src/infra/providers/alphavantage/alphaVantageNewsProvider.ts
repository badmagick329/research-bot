import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../../http/httpJsonClient";

type AlphaVantageTopic = {
  topic?: string;
};

type AlphaVantageTickerSentiment = {
  ticker?: string;
};

type AlphaVantageFeedItem = {
  title?: string;
  url?: string;
  time_published?: string;
  authors?: string[];
  summary?: string;
  source?: string;
  category_within_source?: string;
  topics?: AlphaVantageTopic[];
  ticker_sentiment?: AlphaVantageTickerSentiment[];
  uuid?: string;
};

type AlphaVantageNewsResponse = {
  feed?: AlphaVantageFeedItem[];
};

type AlphaVantageNewsError =
  | {
      code: "http_failure";
      message: string;
      httpStatus?: number;
      retryable: boolean;
      cause?: unknown;
    }
  | { code: "malformed_response"; message: string };

const parseAlphaVantageTimestamp = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  const match = normalized.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
};

/**
 * Adapts Alpha Vantage NEWS_SENTIMENT payloads into the normalized news contract used across ingestion.
 */
export class AlphaVantageNewsProvider implements NewsProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
    private readonly httpClient = new HttpJsonClient(),
  ) {
    if (!this.apiKey.trim()) {
      throw new Error(
        "ALPHA_VANTAGE_API_KEY is required when Alpha Vantage news provider is enabled.",
      );
    }
  }

  /**
   * Returns normalized news entries and tolerates upstream outages with an empty dataset so ingestion can proceed.
   */
  async fetchArticles(
    request: NewsSearchRequest,
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>> {
    const url = new URL("/query", this.baseUrl);
    url.searchParams.set("function", "NEWS_SENTIMENT");
    url.searchParams.set("tickers", request.symbol.toUpperCase());
    url.searchParams.set("limit", String(request.limit));
    url.searchParams.set("sort", "LATEST");
    url.searchParams.set("apikey", this.apiKey);

    const payloadResult =
      await this.httpClient.requestJson<AlphaVantageNewsResponse>({
        url: url.toString(),
        method: "GET",
        timeoutMs: this.timeoutMs,
        retries: 2,
        retryDelayMs: 250,
      });

    if (payloadResult.isErr()) {
      return err(
        this.mapToBoundaryError(
          {
            code: "http_failure",
            message: payloadResult.error.message,
            httpStatus: payloadResult.error.httpStatus,
            retryable: payloadResult.error.retryable,
            cause: payloadResult.error.cause,
          },
          request.symbol,
        ),
      );
    }

    const payload = payloadResult.value;
    if (!payload || !Array.isArray(payload.feed)) {
      return err(
        this.mapToBoundaryError(
          {
            code: "malformed_response",
            message: "Alpha Vantage NEWS_SENTIMENT payload was malformed.",
          },
          request.symbol,
        ),
      );
    }

    return ok(
      payload.feed
        .slice(0, request.limit)
        .map((item, index) =>
          this.toNormalizedItem(request.symbol.toUpperCase(), item, index),
        )
        .filter((item): item is NormalizedNewsItem => item !== null),
    );
  }

  private mapToBoundaryError(
    failure: AlphaVantageNewsError,
    symbol: string,
  ): AppBoundaryError {
    if (failure.code === "malformed_response") {
      return {
        source: "news",
        code: "malformed_response",
        provider: "alphavantage",
        message: failure.message,
        retryable: false,
        cause: { symbol },
      };
    }

    return {
      source: "news",
      code: this.mapHttpCode(failure.httpStatus, failure.message),
      provider: "alphavantage",
      message: failure.message,
      retryable: failure.retryable,
      httpStatus: failure.httpStatus,
      cause: failure.cause,
    };
  }

  private mapHttpCode(
    httpStatus: number | undefined,
    message: string,
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }

    if (/timed out/i.test(message)) {
      return "timeout";
    }

    return "provider_error";
  }

  /**
   * Preserves provider identity fields so persistence upserts remain deterministic across repeated polls.
   */
  private toNormalizedItem(
    symbol: string,
    raw: AlphaVantageFeedItem,
    index: number,
  ): NormalizedNewsItem | null {
    const title = raw.title?.trim();
    if (!title) {
      return null;
    }

    const publishedAt =
      parseAlphaVantageTimestamp(raw.time_published) ?? new Date();

    const providerItemId =
      raw.uuid?.trim() || `${symbol}-${publishedAt.toISOString()}-${index}`;

    const symbols =
      raw.ticker_sentiment
        ?.map((item) => item.ticker?.trim().toUpperCase())
        .filter((item): item is string => Boolean(item)) ?? [];

    if (!symbols.includes(symbol)) {
      symbols.push(symbol);
    }

    const topics =
      raw.topics
        ?.map((item) => item.topic?.trim().toLowerCase())
        .filter((item): item is string => Boolean(item)) ?? [];

    if (topics.length === 0) {
      const fallbackTopic = raw.category_within_source?.trim().toLowerCase();
      if (fallbackTopic) {
        topics.push(fallbackTopic);
      }
    }

    if (topics.length === 0) {
      topics.push("market-news");
    }

    const summary = raw.summary?.trim();

    return {
      id: `alphavantage-${providerItemId}`,
      provider: "alphavantage",
      providerItemId,
      title,
      summary,
      content: summary && summary.length > 0 ? summary : title,
      url: raw.url?.trim() ?? "",
      authors: Array.isArray(raw.authors) ? raw.authors : [],
      publishedAt,
      language: "en",
      symbols,
      topics,
      sentiment: undefined,
      sourceType: "api",
      rawPayload: raw,
    };
  }
}
