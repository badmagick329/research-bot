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
  Information?: string;
  Note?: string;
  ["Error Message"]?: string;
};

type AlphaVantageNewsError =
  | {
      code: "http_failure";
      message: string;
      errorCode:
        | "timeout"
        | "transport_error"
        | "non_success_status"
        | "invalid_json";
      httpStatus?: number;
      retryable: boolean;
      cause?: unknown;
    }
  | { code: "malformed_response"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
   * Returns normalized news entries and surfaces upstream failures as typed boundary errors.
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

    const payloadResult = await this.httpClient.requestJson<unknown>({
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
            errorCode: payloadResult.error.code,
            httpStatus: payloadResult.error.httpStatus,
            retryable: payloadResult.error.retryable,
            cause: payloadResult.error.cause,
          },
          request.symbol,
        ),
      );
    }

    const payload = payloadResult.value;
    if (!isRecord(payload)) {
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

    const infoMessage =
      typeof payload.Information === "string"
        ? payload.Information
        : typeof payload.Note === "string"
          ? payload.Note
          : undefined;

    if (infoMessage) {
      return err({
        source: "news",
        code: "rate_limited",
        provider: "alphavantage",
        message: infoMessage,
        retryable: true,
        cause: { symbol: request.symbol.toUpperCase() },
      });
    }

    const errorMessage =
      typeof payload["Error Message"] === "string"
        ? payload["Error Message"]
        : undefined;

    if (errorMessage) {
      return err({
        source: "news",
        code: /apikey|api key|authentication|invalid/i.test(errorMessage)
          ? "auth_invalid"
          : "provider_error",
        provider: "alphavantage",
        message: errorMessage,
        retryable: false,
        cause: { symbol: request.symbol.toUpperCase() },
      });
    }

    const newsPayload = payload as AlphaVantageNewsResponse;
    if (!Array.isArray(newsPayload.feed)) {
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
      newsPayload.feed
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
      code: this.mapHttpCode(
        failure.httpStatus,
        failure.message,
        failure.errorCode,
      ),
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
    errorCode:
      | "timeout"
      | "transport_error"
      | "non_success_status"
      | "invalid_json",
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }

    if (errorCode === "invalid_json") {
      return "invalid_json";
    }

    if (errorCode === "timeout") {
      return "timeout";
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
