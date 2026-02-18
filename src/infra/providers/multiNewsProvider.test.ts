import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import type {
  NewsProviderPort,
  NewsSearchRequest,
  NormalizedNewsItem,
} from "../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../core/entities/appError";
import { MultiNewsProvider } from "./multiNewsProvider";

class StubNewsProvider implements NewsProviderPort {
  constructor(private readonly items: NormalizedNewsItem[]) {}

  async fetchArticles(
    _: NewsSearchRequest,
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>> {
    return ok(this.items);
  }
}

class ThrowingNewsProvider implements NewsProviderPort {
  async fetchArticles(
    _: NewsSearchRequest,
  ): Promise<Result<NormalizedNewsItem[], AppBoundaryError>> {
    return err({
      source: "news",
      code: "provider_error",
      provider: "stub",
      message: "provider unavailable",
      retryable: true,
    });
  }
}

const buildItem = (
  id: string,
  url: string,
  publishedAtIso: string,
): NormalizedNewsItem => ({
  id,
  provider: "stub",
  providerItemId: id,
  title: `title-${id}`,
  summary: undefined,
  content: `content-${id}`,
  url,
  authors: [],
  publishedAt: new Date(publishedAtIso),
  language: "en",
  symbols: ["AAPL"],
  topics: ["market-news"],
  sentiment: undefined,
  sourceType: "api",
  rawPayload: { id },
});

describe("MultiNewsProvider", () => {
  it("merges providers, dedupes by URL, and keeps latest item", async () => {
    const provider = new MultiNewsProvider([
      new StubNewsProvider([
        buildItem(
          "a1",
          "https://news.example/shared",
          "2026-01-10T10:00:00.000Z",
        ),
        buildItem(
          "a2",
          "https://news.example/unique-a",
          "2026-01-10T08:00:00.000Z",
        ),
      ]),
      new StubNewsProvider([
        buildItem(
          "b1",
          "https://news.example/shared",
          "2026-01-10T12:00:00.000Z",
        ),
        buildItem(
          "b2",
          "https://news.example/unique-b",
          "2026-01-10T09:00:00.000Z",
        ),
      ]),
    ]);

    const items = await provider.fetchArticles({
      symbol: "AAPL",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 10,
    });

    expect(items.isOk()).toBeTrue();
    if (items.isErr()) {
      throw new Error(items.error.message);
    }
    const values = items.value;

    expect(values).toHaveLength(3);
    expect(values[0]?.id).toBe("b1");
    expect(values[1]?.id).toBe("b2");
    expect(values[2]?.id).toBe("a2");
  });

  it("continues when one provider fails", async () => {
    const provider = new MultiNewsProvider([
      new ThrowingNewsProvider(),
      new StubNewsProvider([
        buildItem(
          "ok-1",
          "https://news.example/ok-1",
          "2026-01-10T11:00:00.000Z",
        ),
      ]),
    ]);

    const items = await provider.fetchArticles({
      symbol: "AAPL",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 10,
    });

    expect(items.isOk()).toBeTrue();
    if (items.isErr()) {
      throw new Error(items.error.message);
    }

    expect(items.value).toHaveLength(1);
    expect(items.value[0]?.id).toBe("ok-1");
  });

  it("returns error when all providers fail", async () => {
    const provider = new MultiNewsProvider([
      new ThrowingNewsProvider(),
      new ThrowingNewsProvider(),
    ]);

    const items = await provider.fetchArticles({
      symbol: "AAPL",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-10T00:00:00.000Z"),
      limit: 10,
    });

    expect(items.isErr()).toBeTrue();
  });

  it("throws when no providers are configured", () => {
    expect(() => new MultiNewsProvider([])).toThrow(
      "MultiNewsProvider requires at least one provider.",
    );
  });
});
