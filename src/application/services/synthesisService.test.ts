import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { SynthesisService } from "./synthesisService";
import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { ResearchSnapshotEntity } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  FilingsRepositoryPort,
  JobPayload,
  LlmPort,
  MetricsRepositoryPort,
  SnapshotRepositoryPort,
  ClockPort,
  IdGeneratorPort,
} from "../../core/ports/outboundPorts";

const payload: JobPayload = {
  runId: "run-1",
  taskId: "task-1",
  symbol: "TTWO",
  idempotencyKey: "ttwo-synthesize-hour",
  requestedAt: "2026-02-17T00:00:00.000Z",
};

const validThesis = `# Action Summary
- Decision: Watch [N1] [M1]
- Timeframe fit: Short-term (0-3m) reactive to guidance; Long-term (12m+) constructive if execution persists [N1] [M2]
- Reasons to invest:
  - Product and demand updates remain constructive [N1]
  - Revenue growth still supports medium-term upside if execution holds [M2]
- Reasons to stay away:
  - Current evidence still lacks direct holder-flow confirmation [N1]
  - Regulatory detail on event durability is limited [F1]
- If/Then triggers:
  - If revenue growth remains above 10% then consider gradual accumulation [M2]
  - If filing commentary confirms demand durability then increase conviction [F1]
  - If execution headlines weaken materially then reduce exposure [N1]
- Thesis invalidation:
  - If growth falls below expectations without margin offset then thesis weakens [M2]
  - If filings contradict operational momentum then thesis breaks [F1]

# Overview
TTWO demand remains stable [N1] [M1]

# Shareholder/Institutional Dynamics
Ownership evidence is limited, but guidance focus stayed consistent [N1]

# Valuation and Growth Interpretation
Revenue growth remains positive against current multiple [M1] [M2]

# Regulatory Filings
Recent filing did not contradict operating momentum [F1]

# Missing Evidence
No position-level holder flow provided in evidence [N1]

# Conclusion
Decision remains Watch because evidence quality is still mixed despite constructive signals [N1] [M1] [F1]`;

const noEvidenceThesis = `# Action Summary
- Decision: Watch
- Timeframe fit: Short-term (0-3m) inconclusive; Long-term (12m+) pending evidence
- Reasons to invest:
  - Limited current support from available inputs.
  - Potential upside exists if new disclosures arrive.
- Reasons to stay away:
  - Data coverage is too sparse for directional conviction.
  - Missing metrics and filings prevent durable valuation calls.
- If/Then triggers:
  - If two or more issuer-specific headlines appear then rerun and reassess.
  - If fresh metrics are available then update valuation view.
  - If new filings include quantified guidance then reassess decision.
- Thesis invalidation:
  - If incoming data contradicts current assumptions then reset thesis.
  - If evidence remains sparse across next cycle then defer action.

# Overview
Evidence is sparse for this run.

# Shareholder/Institutional Dynamics
No shareholder-specific data in scope.

# Valuation and Growth Interpretation
No metrics available.

# Regulatory Filings
No filings available.

# Missing Evidence
All sections have direct evidence gaps.

# Conclusion
Cannot form a strong directional view.`;

const createService = (args: {
  docs: DocumentEntity[];
  metrics: MetricPointEntity[];
  filings: FilingEntity[];
  llm: LlmPort;
  now?: Date;
}) => {
  const documentRepo: DocumentRepositoryPort = {
    upsertMany: async () => {},
    listBySymbol: async () => args.docs,
  };

  const metricsRepo: MetricsRepositoryPort = {
    upsertMany: async () => {},
    listBySymbol: async () => args.metrics,
  };

  const filingsRepo: FilingsRepositoryPort = {
    upsertMany: async () => {},
    listBySymbol: async () => args.filings,
  };

  const savedSnapshots: ResearchSnapshotEntity[] = [];
  const snapshotRepo: SnapshotRepositoryPort = {
    save: async (snapshot) => {
      savedSnapshots.push(snapshot);
    },
    latestBySymbol: async () => null,
  };

  const clock: ClockPort = {
    now: () => args.now ?? new Date("2026-02-17T12:00:00.000Z"),
  };

  const ids: IdGeneratorPort = {
    next: () => "snapshot-1",
  };

  const service = new SynthesisService(
    documentRepo,
    metricsRepo,
    filingsRepo,
    snapshotRepo,
    args.llm,
    clock,
    ids,
  );

  return { service, savedSnapshots };
};

describe("SynthesisService", () => {
  it("prioritizes issuer-relevant headlines and includes relevance diagnostics", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-1",
        type: "news",
        title: "TTWO issues updated game launch guidance",
        summary: "Take-Two updated guidance.",
        content: "TTWO updated guidance details.",
        url: "https://example.com/ttwo",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["guidance"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
      {
        id: "doc-2",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-2",
        type: "news",
        title: "Stocks to buy this week across Wall Street",
        summary: "Broad market summary",
        content: "No issuer-specific detail.",
        url: "https://example.com/noise",
        publishedAt: new Date("2026-02-17T07:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "SPY,QQQ" },
        createdAt: new Date("2026-02-17T07:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "market_cap",
        metricValue: 33000000000,
        metricUnit: "usd",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-2",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.08,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];

    const filings: FilingEntity[] = [
      {
        id: "filing-1",
        dedupeKey: "accession:0000000000-26-000001",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000001",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://sec.example/filing-1",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
    ];

    const prompts: string[] = [];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        prompts.push(prompt);
        return ok(validThesis);
      },
    };

    const { service, savedSnapshots } = createService({
      docs,
      metrics,
      filings,
      llm,
    });

    await service.run(payload);

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("News relevance diagnostics:");
    expect(prompts[0]).toContain("relevantHeadlinesCount=1");
    expect(prompts[0]).toContain("relevanceCoverage=1/1");
    expect(prompts[0]).toContain("evidenceWeak=true");
    expect(prompts[0]).toContain(
      "Return Markdown with headings in this order: Action Summary, Overview",
    );
    expect(prompts[0]).toContain(
      "If evidenceWeak=true, default Decision to Watch",
    );
    expect(prompts[0]).toContain("N1 finnhub: TTWO issues updated game launch guidance");
    expect(prompts[0]).not.toContain("Stocks to buy this week across Wall Street");

    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.thesis).toBe(validThesis);
    expect(saved.thesis.startsWith("# Action Summary")).toBeTrue();
    expect(saved.thesis).toContain("- If/Then triggers:");
    expect(saved.score).toBe(24.5);
    expect(saved.confidence).toBe(0.82);
  });

  it("keeps no-evidence runs without forcing citation repair", async () => {
    const prompts: string[] = [];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        prompts.push(prompt);
        return ok(validThesis);
      },
    };

    const { service, savedSnapshots } = createService({
      docs: [],
      metrics: [],
      filings: [],
      llm,
    });

    await service.run(payload);

    expect(prompts.length).toBe(1);
    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.score).toBe(0);
    expect(saved.confidence).toBe(0.1);
  });

  it("filters mock evidence when real provider evidence exists", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-real",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "r1",
        type: "news",
        title: "TTWO product cycle update",
        summary: "",
        content: "TTWO launch details",
        url: "https://example.com/real-news",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["product"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
      {
        id: "doc-mock",
        symbol: "TTWO",
        provider: "mock-news-wire",
        providerItemId: "m1",
        type: "news",
        title: "Mock provider headline",
        summary: "",
        content: "content",
        url: "https://example.com/mock-news",
        publishedAt: new Date("2026-02-17T07:00:00.000Z"),
        language: "en",
        topics: ["ownership"],
        sourceType: "api",
        rawPayload: {},
        createdAt: new Date("2026-02-17T07:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-real",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "market_cap",
        metricValue: 33000000000,
        metricUnit: "usd",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-mock",
        symbol: "TTWO",
        provider: "mock-fundamentals",
        metricName: "ev_to_ebitda",
        metricValue: 17.4,
        metricUnit: "multiple",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "ttm",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.6,
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];

    const filings: FilingEntity[] = [
      {
        id: "filing-real",
        dedupeKey: "accession:0000000000-26-000001",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "10-Q",
        accessionNo: "0000000000-26-000001",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://sec.example/10q",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
      {
        id: "filing-mock",
        dedupeKey: "accession:000000-2026-000001",
        symbol: "TTWO",
        provider: "mock-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "10-Q",
        accessionNo: "000000-2026-000001",
        filedAt: new Date("2026-02-14T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://example.local/filings/TTWO/10q",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-14T00:00:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };

    const { service, savedSnapshots } = createService({
      docs,
      metrics,
      filings,
      llm,
    });

    await service.run(payload);

    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(
      saved.sources.some((source) => source.provider === "mock-news-wire"),
    ).toBe(false);
    expect(
      saved.sources.some((source) => source.provider === "mock-fundamentals"),
    ).toBe(false);
    expect(
      saved.sources.some((source) => source.provider === "mock-edgar"),
    ).toBe(false);
  });

  it("runs a single repair prompt when first thesis fails validation", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-1",
        type: "news",
        title: "TTWO demand update",
        summary: "TTWO details",
        content: "TTWO details",
        url: "https://example.com/ttwo",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["guidance"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "market_cap",
        metricValue: 33000000000,
        metricUnit: "usd",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
    ];

    const filings: FilingEntity[] = [
      {
        id: "filing-1",
        dedupeKey: "accession:0000000000-26-000001",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000001",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://sec.example/filing-1",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
    ];

    const prompts: string[] = [];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        prompts.push(prompt);
        if (prompt.includes("Repair this thesis draft")) {
          return ok(validThesis);
        }

        return ok("short uncited thesis");
      },
    };

    const { service, savedSnapshots } = createService({
      docs,
      metrics,
      filings,
      llm,
    });

    await service.run(payload);

    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Repair this thesis draft");
    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.thesis).toBe(validThesis);
  });

  it("switches identity uncertainty instruction based on identity quality and relevance", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-1",
        type: "news",
        title: "Broad market premarket moves",
        summary: "No issuer detail",
        content: "No issuer detail",
        url: "https://example.com/noise",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "SPY" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];

    const prompts: string[] = [];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        prompts.push(prompt);
        return ok(noEvidenceThesis);
      },
    };

    const manualMapRun = createService({ docs: [], metrics: [], filings: [], llm });
    await manualMapRun.service.run({
      ...payload,
      resolvedIdentity: {
        requestedSymbol: "AMZN",
        canonicalSymbol: "AMZN",
        companyName: "Amazon.com, Inc.",
        aliases: ["AMZN"],
        exchange: "NASDAQ",
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
    });

    const heuristicRun = createService({ docs, metrics: [], filings: [], llm });
    await heuristicRun.service.run({
      ...payload,
      resolvedIdentity: {
        requestedSymbol: "ABCD",
        canonicalSymbol: "ABCD",
        companyName: "ABCD",
        aliases: ["ABCD"],
        confidence: 0.4,
        resolutionSource: "heuristic",
      },
    });

    expect(prompts[0]).toContain(
      "Never describe the symbol as a placeholder or unknown identifier.",
    );
    expect(prompts[1]).toContain(
      "Explicitly mention identity uncertainty in Missing Evidence.",
    );
  });
});
