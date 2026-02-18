import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../../http/httpJsonClient";

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

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

type FinnhubNewsError =
  | { code: "config_invalid"; message: string }
  | {
      code: "http_failure";
      message: string;
      httpStatus?: number;
      retryable: boolean;
      cause?: unknown;
    }
  | { code: "malformed_response"; message: string; cause?: unknown };

/**
 * Translates Finnhub company-news payloads into the app's normalized news contract.
 */
export class FinnhubNewsProvider implements NewsProviderPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
    private readonly httpClient = new HttpJsonClient(),
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
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>> {
    const url = new URL("/api/v1/company-news", this.baseUrl);
    url.searchParams.set("symbol", request.symbol.toUpperCase());
    url.searchParams.set("from", toIsoDate(request.from));
    url.searchParams.set("to", toIsoDate(request.to));
    url.searchParams.set("token", this.apiKey);

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
            httpStatus: payloadResult.error.httpStatus,
            retryable: payloadResult.error.retryable,
            cause: payloadResult.error.cause,
          },
          request.symbol,
        ),
      );
    }

    const payload = payloadResult.value;
    if (!Array.isArray(payload)) {
      return err(
        this.mapToBoundaryError(
          {
            code: "malformed_response",
            message: "Finnhub news response was not an array.",
          },
          request.symbol,
        ),
      );
    }

    return ok(
      payload
        .slice(0, request.limit)
        .map((item, index) =>
          this.toNormalizedItem(request.symbol.toUpperCase(), item, index),
        )
        .filter((item): item is NormalizedNewsItem => item !== null),
    );
  }

  private mapToBoundaryError(
    failure: FinnhubNewsError,
    symbol: string,
  ): AppBoundaryError {
    if (failure.code === "config_invalid") {
      return {
        source: "news",
        code: "config_invalid",
        provider: "finnhub",
        message: failure.message,
        retryable: false,
        cause: { symbol },
      };
    }

    if (failure.code === "malformed_response") {
      return {
        source: "news",
        code: "malformed_response",
        provider: "finnhub",
        message: failure.message,
        retryable: false,
        cause: failure.cause,
      };
    }

    return {
      source: "news",
      code: this.mapHttpCode(failure.httpStatus, failure.message),
      provider: "finnhub",
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
