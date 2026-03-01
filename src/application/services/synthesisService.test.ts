import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { SynthesisService } from "./synthesisService";
import type { DocumentEntity } from "../../core/entities/document";
import type { FilingEntity } from "../../core/entities/filing";
import type { MetricPointEntity } from "../../core/entities/metric";
import type { ResearchSnapshotEntity } from "../../core/entities/research";
import type {
  DocumentRepositoryPort,
  EmbeddingMemoryRepositoryPort,
  EmbeddingPort,
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
  - If revenue growth remains above 10% then add 10% position size [M2]
  - If filing commentary confirms demand durability=true then upgrade one notch [F1]
  - If issuer-relevant headlines fall below 2 then reduce exposure [N1]
- Thesis invalidation:
  - If growth falls below expectations without margin offset then thesis weakens [M2]
  - If filings contradict operational momentum then thesis breaks [F1]

# Evidence Map
- N1: TTWO issues updated game launch guidance
- M1: market_cap=33.00B usd
- M2: revenue_growth_yoy=0.0800 ratio
- F1: 8-K 2026-02-15

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

# Evidence Map
- none

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
  embeddingPort?: EmbeddingPort;
  memoryRepo?: EmbeddingMemoryRepositoryPort;
  previousSnapshot?: ResearchSnapshotEntity | null;
  options?: ConstructorParameters<typeof SynthesisService>[9];
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
    latestBySymbol: async () => args.previousSnapshot ?? null,
  };

  const clock: ClockPort = {
    now: () => args.now ?? new Date("2026-02-17T12:00:00.000Z"),
  };

  const ids: IdGeneratorPort = {
    next: () => "snapshot-1",
  };

  const embeddingPort: EmbeddingPort =
    args.embeddingPort ??
    ({
      embedTexts: async () => ok([[0.11, 0.22, 0.33]]),
    } satisfies EmbeddingPort);

  const memoryRepo: EmbeddingMemoryRepositoryPort =
    args.memoryRepo ??
    ({
      findSimilarBySymbol: async () => [],
    } satisfies EmbeddingMemoryRepositoryPort);

  const service = new SynthesisService(
    documentRepo,
    metricsRepo,
    filingsRepo,
    embeddingPort,
    memoryRepo,
    snapshotRepo,
    args.llm,
    clock,
    ids,
    args.options,
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
    expect(prompts[0]).toContain(
      "N_issuer1 finnhub: TTWO issues updated game launch guidance",
    );
    expect(prompts[0]).toContain("excludedHeadlines=1");
    expect(prompts[0]).toContain("excludedSample=Stocks to buy this week across Wall Street");

    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.thesis).toContain("# Evidence Map");
    expect(saved.thesis).toContain(
      '- N_issuer1: news "TTWO issues updated game launch guidance"',
    );
    expect(saved.thesis).toContain("- M1: metric market_cap=33.00B usd");
    expect(saved.thesis).toContain("- M2: metric revenue_growth_yoy=0.0800 ratio");
    expect(saved.thesis).toContain("- F1: filing 8-K 2026-02-15");
    expect(saved.thesis.startsWith("# Action Summary")).toBeTrue();
    expect(saved.thesis).toContain("- If/Then triggers:");
    expect(saved.score).toBe(24.5);
    expect(saved.confidence).toBe(0.82);
  });

  it("rejects noisy issuer-adjacent headlines even when symbol matched", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-noisy",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "f-noisy",
        type: "news",
        title: "Stock Market Today: Dow Higher After Jobless Claims; Nvidia Rallies On Earnings (Live Coverage)",
        summary: "Broad market live coverage with Nvidia mention.",
        content: "NVIDIA mention appears in broad market wrap and futures context.",
        url: "https://example.com/noisy-nvda",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "NVDA,SPY,QQQ" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
      {
        id: "doc-high",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "f-high",
        type: "news",
        title: "NVIDIA raises data-center guidance and expands capacity",
        summary: "Issuer guidance update tied to demand and gross margin.",
        content:
          "NVIDIA guidance update improves demand outlook, gross_margin, and revenue_growth_yoy expectations.",
        url: "https://example.com/high-nvda",
        publishedAt: new Date("2026-02-17T09:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "NVDA" },
        createdAt: new Date("2026-02-17T09:00:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };

    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "NVDA",
      resolvedIdentity: {
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        companyName: "NVIDIA Corporation",
        aliases: ["NVDA"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      kpiContext: {
        template: "semis",
        required: ["revenue_growth_yoy", "gross_margin"],
        optional: ["price_to_earnings"],
        selected: ["revenue_growth_yoy", "gross_margin"],
        requiredHitCount: 2,
        minRequiredForStrongNote: 2,
      },
    });

    const saved = savedSnapshots[0];
    expect(
      saved?.diagnostics?.newsQualityV2?.excludedByReason
        .issuer_noise_or_adjacent_context ?? 0,
    ).toBeGreaterThan(0);
    expect(saved?.thesis).toContain(
      '- N_issuer1: news "NVIDIA raises data-center guidance and expands capacity"',
    );
    expect(saved?.thesis).not.toContain(
      "Stock Market Today: Dow Higher After Jobless Claims; Nvidia Rallies On Earnings (Live Coverage)",
    );
    expect(saved?.diagnostics?.issuerMatchDiagnostics).toBeDefined();
  });

  it("rejects payload-only issuer matches and records diagnostics counts", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-payload-only",
        symbol: "AMZN",
        provider: "finnhub",
        providerItemId: "f-payload-only",
        type: "news",
        title: "Broad market wrap with utilities earnings",
        summary: "No issuer name in narrative fields.",
        content: "Headline discusses utilities and indexes only.",
        url: "https://example.com/payload-only",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "AMZN" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(noEvidenceThesis),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "AMZN",
      resolvedIdentity: {
        requestedSymbol: "AMZN",
        canonicalSymbol: "AMZN",
        companyName: "Amazon.com, Inc.",
        aliases: ["AMZN"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
    });

    const saved = savedSnapshots[0];
    expect(
      saved?.diagnostics?.newsQualityV2?.excludedByReason
        .payload_only_issuer_match ?? 0,
    ).toBeGreaterThan(0);
    expect(saved?.diagnostics?.issuerMatchDiagnostics?.payloadOnlyRejected).toBe(1);
  });

  it("uses metric and filing refs when selected news is empty and filters unresolved investor KPIs", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-payload-only-citations",
        symbol: "AMZN",
        provider: "finnhub",
        providerItemId: "f-payload-only-citations",
        type: "news",
        title: "Broad market wrap with no issuer narrative",
        summary: "Payload contains symbol but title/summary/content do not.",
        content: "Sector and index recap only.",
        url: "https://example.com/payload-only-citations",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "AMZN" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];
    const metrics: MetricPointEntity[] = [
      {
        id: "metric-citation-1",
        symbol: "AMZN",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "quarter",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-citation-2",
        symbol: "AMZN",
        provider: "alphavantage",
        metricName: "price_to_earnings",
        metricValue: 28,
        metricUnit: "multiple",
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
        id: "filing-citation-1",
        dedupeKey: "accession:0000000000-26-000999",
        symbol: "AMZN",
        provider: "sec-edgar",
        issuerName: "Amazon.com, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000999",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        periodEnd: undefined,
        docUrl: "https://sec.example/filing-citation-1",
        sections: [],
        extractedFacts: [],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
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

    await service.run({
      ...payload,
      symbol: "AMZN",
      resolvedIdentity: {
        requestedSymbol: "AMZN",
        canonicalSymbol: "AMZN",
        companyName: "Amazon.com, Inc.",
        aliases: ["AMZN"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      kpiContext: {
        template: "retail_consumer",
        required: ["revenue_growth_yoy"],
        optional: ["missing_metric_for_test"],
        selected: ["revenue_growth_yoy", "missing_metric_for_test"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 1,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.newsQualityV2?.included).toBe(0);
    expect(saved?.thesis).not.toContain("N_issuer1");
    expect(
      saved?.investorViewV2?.catalysts.every((catalyst) =>
        catalyst.evidenceRefs.every((ref) => /^(M|F)\d+$/.test(ref)),
      ),
    ).toBeTrue();
    expect(
      saved?.investorViewV2?.falsification.every((item) =>
        item.evidenceRefs.every((ref) => /^(M|F)\d+$/.test(ref)),
      ),
    ).toBeTrue();
    expect(
      saved?.investorViewV2?.keyKpis.every(
        (kpi) => kpi.value !== "n/a" && kpi.evidenceRefs.length > 0,
      ),
    ).toBeTrue();
    expect(
      saved?.investorViewV2?.keyKpis.some(
        (kpi) => kpi.name === "missing_metric_for_test",
      ),
    ).toBeFalse();
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

    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.score).toBe(0);
    expect(saved.confidence).toBe(0.1);
  });

  it("forces insufficient_evidence decision when evidence minimum gate fails", async () => {
    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok(noEvidenceThesis),
    };

    const { service, savedSnapshots } = createService({
      docs: [],
      metrics: [],
      filings: [],
      llm,
    });

    await service.run(payload);

    const saved = savedSnapshots[0];
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(saved.investorViewV2?.action.decision).toBe("insufficient_evidence");
    expect(saved.investorViewV2?.action.positionSizing).toBe("none");
    expect(saved.diagnostics?.evidenceGate?.passed).toBeFalse();
    expect(saved.thesis).toContain("- Decision: Insufficient Evidence");
  });

  it("returns watch_low_quality when only sector KPI quality is weak", async () => {
    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok(validThesis),
    };
    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "quarter",
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
        metricName: "profit_margin",
        metricValue: 0.21,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "ttm",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-3",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "price_to_earnings",
        metricValue: 25,
        metricUnit: "multiple",
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
    const { service, savedSnapshots } = createService({
      docs: [],
      metrics,
      filings,
      llm,
    });

    await service.run({
      ...payload,
      kpiContext: {
        template: "software_saas",
        required: ["revenue_growth_yoy", "profit_margin"],
        optional: ["analyst_buy_ratio"],
        selected: ["revenue_growth_yoy", "profit_margin"],
        requiredHitCount: 2,
        minRequiredForStrongNote: 2,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.investorViewV2?.action.decision).toBe("watch_low_quality");
    expect(saved?.investorViewV2?.action.positionSizing).toBe("small");
    expect(saved?.diagnostics?.kpiCoverage?.mode).toBe("grace_low_quality");
  });

  it("forces insufficient_evidence when core KPI floor fails", async () => {
    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok(validThesis),
    };
    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "quarter",
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
        metricName: "price_to_earnings",
        metricValue: 25,
        metricUnit: "multiple",
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
    const { service, savedSnapshots } = createService({
      docs: [],
      metrics,
      filings,
      llm,
    });

    await service.run({
      ...payload,
      kpiContext: {
        template: "software_saas",
        required: ["revenue_growth_yoy", "profit_margin"],
        optional: ["analyst_buy_ratio"],
        selected: ["revenue_growth_yoy"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 2,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.investorViewV2?.action.decision).toBe("insufficient_evidence");
    expect(saved?.diagnostics?.evidenceGate?.failures).toContain(
      "insufficient_core_kpi_items",
    );
  });

  it("preserves grace-mode decision when fallback thesis is applied", async () => {
    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok("watch and monitor developments"),
    };
    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "quarter",
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
        metricName: "profit_margin",
        metricValue: 0.21,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "ttm",
        periodStart: undefined,
        periodEnd: undefined,
        confidence: 0.85,
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "metric-3",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "price_to_earnings",
        metricValue: 25,
        metricUnit: "multiple",
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
    const { service, savedSnapshots } = createService({
      docs: [],
      metrics,
      filings,
      llm,
    });

    await service.run({
      ...payload,
      kpiContext: {
        template: "software_saas",
        required: ["revenue_growth_yoy", "profit_margin"],
        optional: ["analyst_buy_ratio"],
        selected: ["revenue_growth_yoy", "profit_margin"],
        requiredHitCount: 2,
        minRequiredForStrongNote: 2,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.thesisQuality?.fallbackApplied).toBeTrue();
    expect(saved?.investorViewV2?.action.decision).toBe("watch_low_quality");
    expect(saved?.diagnostics?.thesisQuality?.failedChecks).not.toContain(
      "weak_or_uncited_decision_line",
    );
    expect(saved?.thesis).toContain("- Decision: Watch (Low Quality)");
  });

  it("uses carried-forward KPI coverage in diagnostics only", async () => {
    const llm: LlmPort = {
      summarize: async () => ok("unused"),
      synthesize: async () => ok(validThesis),
    };
    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.12,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "quarter",
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
        metricName: "price_to_earnings",
        metricValue: 25,
        metricUnit: "multiple",
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
    const previousSnapshot: ResearchSnapshotEntity = {
      id: "snap-prev-1",
      runId: "run-prev-1",
      taskId: "task-prev-1",
      symbol: "TTWO",
      horizon: "1_2_quarters",
      score: 25,
      thesis: "prior",
      risks: [],
      catalysts: [],
      valuationView: "fair",
      confidence: 0.8,
      sources: [],
      investorViewV2: {
        thesisType: "compounder",
        action: { decision: "watch", positionSizing: "small" },
        horizon: { bucket: "1_2_quarters", rationale: "prior" },
        summary: { oneLineThesis: "prior" },
        variantView: {
          pricedInNarrative: "prior",
          ourVariant: "prior",
          whyMispriced: "prior",
        },
        drivers: [],
        keyKpis: [
          {
            name: "profit_margin",
            value: "0.20",
            trend: "flat",
            whyItMatters: "prior",
            evidenceRefs: ["M1"],
          },
          {
            name: "analyst_buy_ratio",
            value: "0.70",
            trend: "flat",
            whyItMatters: "prior",
            evidenceRefs: ["M2"],
          },
        ],
        catalysts: [],
        falsification: [],
        valuation: {
          valuationFramework: "prior",
          keyMultiples: [],
          historyContext: "prior",
          peerContext: "prior",
          valuationView: "fair",
        },
        confidence: {
          dataConfidence: 70,
          thesisConfidence: 70,
          timingConfidence: 70,
        },
      },
      createdAt: new Date("2026-02-10T00:00:00.000Z"),
    };
    const { service, savedSnapshots } = createService({
      docs: [],
      metrics,
      filings,
      llm,
      previousSnapshot,
    });

    await service.run({
      ...payload,
      kpiContext: {
        template: "software_saas",
        required: ["revenue_growth_yoy", "profit_margin"],
        optional: ["analyst_buy_ratio"],
        selected: ["revenue_growth_yoy"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 2,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.investorViewV2?.action.decision).not.toBe("insufficient_evidence");
    expect(
      saved?.diagnostics?.kpiCoverage?.carriedKpis.map((item) => item.name),
    ).toEqual(["profit_margin", "analyst_buy_ratio"]);
    expect(
      saved?.investorViewV2?.keyKpis.some((kpi) => kpi.name === "profit_margin"),
    ).toBeFalse();
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

    expect(saved.thesis).toContain("# Evidence Map");
    expect(saved.thesis).toContain('- N_issuer1: news "TTWO demand update"');
    expect(saved.thesis).toContain("- M1: metric market_cap=33.00B usd");
    expect(saved.thesis).toContain("- F1: filing 8-K 2026-02-15");
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
    expect(
      prompts.some((prompt) =>
        prompt.includes("Explicitly mention identity uncertainty in Missing Evidence."),
      ),
    ).toBeTrue();
  });

  it("excludes no-issuer-match headlines and records news quality diagnostics", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "n-1",
        type: "news",
        title: "Is Sandisk Stock Your Ticket to Becoming a Millionaire?",
        summary: "Broad narrative unrelated to issuer",
        content: "No issuer mention here",
        url: "https://example.com/noise-1",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["market-news"],
        sourceType: "api",
        rawPayload: { related: "SNDK" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
      {
        id: "doc-2",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "n-2",
        type: "news",
        title: "NVIDIA posts stronger-than-expected data center growth",
        summary: "NVIDIA demand remains strong",
        content: "NVDA momentum",
        url: "https://example.com/nvda-1",
        publishedAt: new Date("2026-02-17T09:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "NVDA" },
        createdAt: new Date("2026-02-17T09:00:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "NVDA",
      resolvedIdentity: {
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        companyName: "NVIDIA Corporation",
        aliases: ["NVDA"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
    });

    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }
    expect(saved.diagnostics?.newsQuality?.total).toBe(2);
    expect(saved.diagnostics?.newsQuality?.issuerMatched).toBe(1);
    expect(saved.diagnostics?.newsQuality?.excluded).toBe(1);
    expect(saved.diagnostics?.newsQualityV2?.mode).toBe("enforce");
    expect(saved.diagnostics?.newsQualityV2?.excludedByReason).toBeDefined();
  });

  it("keeps company-name-only headlines when identity company name matches", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "n-1",
        type: "news",
        title: "NVIDIA Corporation expands AI capacity",
        summary: "company-name-only mention",
        content: "no ticker string",
        url: "https://example.com/nvda-company-name",
        publishedAt: new Date("2026-02-17T09:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "XYZ" },
        createdAt: new Date("2026-02-17T09:00:00.000Z"),
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
    const { service } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });
    await service.run({
      ...payload,
      symbol: "NVDA",
      resolvedIdentity: {
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        companyName: "NVIDIA Corporation",
        aliases: ["NVDA"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
    });

    expect(prompts[0]).toContain(
      "N_issuer1 finnhub: NVIDIA Corporation expands AI capacity",
    );
  });

  it("produces non-watch decisions when deterministic policy gates are met", async () => {
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };

    const buyMetrics: MetricPointEntity[] = [
      {
        id: "m-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "price_to_earnings",
        metricValue: 20,
        metricUnit: "multiple",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "m-2",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.25,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "m-3",
        symbol: "TTWO",
        provider: "finnhub-market-context",
        metricName: "analyst_buy_ratio",
        metricValue: 0.7,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];

    const buyDocs: DocumentEntity[] = [
      {
        id: "doc-b-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-1",
        type: "news",
        title: "TTWO launches high-demand title",
        summary: "TTWO expansion",
        content: "TTWO growth detail",
        url: "https://example.com/buy-1",
        publishedAt: new Date("2026-02-17T10:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T10:00:00.000Z"),
      },
      {
        id: "doc-b-2",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-2",
        type: "news",
        title: "TTWO management reiterates growth outlook",
        summary: "TTWO guidance",
        content: "TTWO outlook detail",
        url: "https://example.com/buy-2",
        publishedAt: new Date("2026-02-17T09:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T09:00:00.000Z"),
      },
      {
        id: "doc-b-3",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-3",
        type: "news",
        title: "TTWO demand remains resilient in latest quarter",
        summary: "TTWO demand resilience",
        content: "TTWO demand evidence",
        url: "https://example.com/buy-3",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];
    const buyFilings: FilingEntity[] = [
      {
        id: "filing-b-1",
        dedupeKey: "accession:0000000000-26-000900",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000900",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        docUrl: "https://sec.example/b-1",
        sections: [],
        extractedFacts: [
          { name: "mentions_demand_strength", value: "true" },
          { name: "content_extraction_status", value: "parsed" },
        ],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
    ];

    const { service: buyService, savedSnapshots: buySnapshots } = createService({
      docs: buyDocs,
      metrics: buyMetrics,
      filings: buyFilings,
      llm,
    });

    await buyService.run(payload);
    expect(buySnapshots[0]?.thesis).toContain("Decision: Buy");
    expect(buySnapshots[0]?.diagnostics?.decisionReasons?.includes("strong_growth_with_acceptable_valuation")).toBeTrue();
    expect(buySnapshots[0]?.diagnostics?.thesisQuality?.fallbackApplied).toBeFalse();
    expect(buySnapshots[0]?.investorViewV2?.confidence.thesisConfidence ?? 0).toBeGreaterThan(50);
    expect(buySnapshots[0]?.investorViewV2?.confidence.timingConfidence ?? 0).toBeGreaterThan(60);

    const oneAnchorDocs: DocumentEntity[] = [
      {
        id: "doc-b-one-anchor",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-one-anchor",
        type: "news",
        title: "TTWO reiterates revenue growth and profit margin outlook",
        summary: "Issuer KPI-linked update",
        content:
          "TTWO update explicitly references revenue_growth_yoy, profit_margin, and analyst_buy_ratio checkpoints.",
        url: "https://example.com/b-one-anchor",
        publishedAt: new Date("2026-02-17T10:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T10:00:00.000Z"),
      },
      {
        id: "doc-b-peer-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-peer-1",
        type: "news",
        title: "Peer competitor highlights revenue growth shift",
        summary: "peer competitor KPI read-through",
        content:
          "peer competitor demand update points to revenue_growth_yoy and profit_margin trajectory changes.",
        url: "https://example.com/b-peer-1",
        publishedAt: new Date("2026-02-17T09:30:00.000Z"),
        language: "en",
        topics: ["industry-news"],
        sourceType: "api",
        rawPayload: { related: "EA" },
        createdAt: new Date("2026-02-17T09:30:00.000Z"),
      },
      {
        id: "doc-b-peer-2",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "b-peer-2",
        type: "news",
        title: "Customer contract read-through signals demand momentum",
        summary: "customer contract and KPI linkage",
        content:
          "customer order book and contract commentary references revenue_growth_yoy and profit_margin trends.",
        url: "https://example.com/b-peer-2",
        publishedAt: new Date("2026-02-17T09:10:00.000Z"),
        language: "en",
        topics: ["industry-news"],
        sourceType: "api",
        rawPayload: { related: "SONY" },
        createdAt: new Date("2026-02-17T09:10:00.000Z"),
      },
    ];
    const { service: oneAnchorService, savedSnapshots: oneAnchorSnapshots } = createService({
      docs: oneAnchorDocs,
      metrics: buyMetrics,
      filings: buyFilings,
      llm,
    });
    await oneAnchorService.run({
      ...payload,
      kpiContext: {
        template: "software_saas",
        required: ["revenue_growth_yoy", "profit_margin"],
        optional: ["analyst_buy_ratio"],
        selected: ["revenue_growth_yoy", "profit_margin", "analyst_buy_ratio"],
        requiredHitCount: 2,
        minRequiredForStrongNote: 2,
      },
    });
    expect(oneAnchorSnapshots[0]?.investorViewV2?.action.decision).toBe("watch");
    expect(oneAnchorSnapshots[0]?.diagnostics?.readThroughQualityV2?.issuerIncluded).toBe(1);
    expect(
      (oneAnchorSnapshots[0]?.diagnostics?.decisionReasons ?? []).some(
        (reason) =>
          reason === "insufficient_issuer_anchors" || reason === "evidence_weak",
      ),
    ).toBeTrue();

    const avoidFilings: FilingEntity[] = [
      {
        id: "filing-a-1",
        dedupeKey: "accession:0000000000-26-000901",
        symbol: "TTWO",
        provider: "sec-edgar",
        issuerName: "Take-Two Interactive Software, Inc.",
        filingType: "8-K",
        accessionNo: "0000000000-26-000901",
        filedAt: new Date("2026-02-15T00:00:00.000Z"),
        docUrl: "https://sec.example/a-1",
        sections: [],
        extractedFacts: [
          { name: "mentions_regulatory_action", value: "true" },
          { name: "content_extraction_status", value: "parsed" },
        ],
        rawPayload: {},
        createdAt: new Date("2026-02-15T00:00:00.000Z"),
      },
    ];

    const avoidMetrics: MetricPointEntity[] = [
      {
        id: "m-a-1",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "price_to_earnings",
        metricValue: 60,
        metricUnit: "multiple",
        currency: "USD",
        asOf: new Date("2026-02-17T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-17T00:00:00.000Z"),
      },
      {
        id: "m-a-2",
        symbol: "TTWO",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.18,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "m-a-3",
        symbol: "TTWO",
        provider: "finnhub-market-context",
        metricName: "analyst_buy_ratio",
        metricValue: 0.65,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];
    const { service: avoidService, savedSnapshots: avoidSnapshots } = createService({
      docs: buyDocs,
      metrics: avoidMetrics,
      filings: avoidFilings,
      llm,
    });
    await avoidService.run(payload);
    expect(avoidSnapshots[0]?.thesis).toContain("Decision: Avoid");
    expect(avoidSnapshots[0]?.diagnostics?.decisionReasons?.includes("high_valuation_with_filing_risk")).toBeTrue();
  });

  it("tags duplicate-title and duplicate-url exclusions in news quality diagnostics", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "d-1",
        type: "news",
        title: "TTWO launches expansion title",
        summary: "TTWO update",
        content: "TTWO update details",
        url: "https://example.com/a?utm_source=x",
        publishedAt: new Date("2026-02-17T10:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T10:00:00.000Z"),
      },
      {
        id: "doc-2",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "d-2",
        type: "news",
        title: "TTWO launches expansion title",
        summary: "same headline",
        content: "same headline content",
        url: "https://example.com/b",
        publishedAt: new Date("2026-02-17T09:50:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T09:50:00.000Z"),
      },
      {
        id: "doc-3",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "d-3",
        type: "news",
        title: "TTWO demand signals remain solid",
        summary: "TTWO summary",
        content: "TTWO summary content",
        url: "https://example.com/a",
        publishedAt: new Date("2026-02-17T09:40:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T09:40:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });
    await service.run(payload);
    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.newsQuality?.excludedReasonsSample?.some((line) => line.includes("duplicate_title"))).toBeTrue();
    expect(saved?.diagnostics?.newsQuality?.excludedReasonsSample?.some((line) => line.includes("duplicate_url"))).toBeTrue();
    expect(saved?.diagnostics?.newsQualityV2?.excludedByReason.duplicate_title).toBeDefined();
    expect(saved?.diagnostics?.newsQualityV2?.excludedByReason.duplicate_url).toBeDefined();
  });

  it("includes SEC companyfacts metrics in persisted source context", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-cf-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "cf-1",
        type: "news",
        title: "TTWO demand update",
        summary: "",
        content: "TTWO demand update details",
        url: "https://example.com/cf-news",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-cf-1",
        symbol: "TTWO",
        provider: "sec-companyfacts",
        metricName: "revenue_growth_yoy",
        metricValue: 0.22,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "metric-cf-2",
        symbol: "TTWO",
        provider: "sec-companyfacts",
        metricName: "profit_margin",
        metricValue: 0.18,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "metric-cf-3",
        symbol: "TTWO",
        provider: "sec-companyfacts",
        metricName: "gross_margin",
        metricValue: 0.56,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };

    const { service, savedSnapshots } = createService({
      docs,
      metrics,
      filings: [],
      llm,
    });
    await service.run(payload);

    const saved = savedSnapshots.at(0);
    if (!saved) {
      throw new Error("expected snapshot to be saved");
    }

    expect(
      saved.sources.some((source) => source.provider === "sec-companyfacts"),
    ).toBeTrue();
  });

  it("enforces issuer-anchor and read-through cap policy with class diagnostics", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-issuer",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "issuer-1",
        type: "news",
        title: "NVDA guidance and revenue growth update",
        summary: "NVIDIA demand and margin outlook",
        content:
          "NVIDIA next earnings guidance update revenue_growth_yoy profit_margin demand margin contract launch capacity expansion remains strong.",
        url: "https://example.com/nvda-anchor",
        publishedAt: new Date("2026-02-17T11:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "NVDA" },
        createdAt: new Date("2026-02-17T11:00:00.000Z"),
      },
      ...[1, 2, 3, 4, 5].map((index) => ({
        id: `doc-peer-${index}`,
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: `peer-${index}`,
        type: "news" as const,
        title: `Peer competitor guidance revenue growth signal ${index}`,
        summary: "peer and competitor margin signal",
        content:
          "peer competitor next earnings guidance update revenue_growth_yoy profit_margin demand margin litigation regulation contract launch capacity expansion trend remains notable.",
        url: `https://example.com/peer-${index}`,
        publishedAt: new Date(`2026-02-17T0${index}:00:00.000Z`),
        language: "en",
        topics: ["industry-news"],
        sourceType: "api" as const,
        rawPayload: { related: "AMD" },
        createdAt: new Date(`2026-02-17T0${index}:00:00.000Z`),
      })),
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(validThesis),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "NVDA",
      resolvedIdentity: {
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        companyName: "NVIDIA Corporation",
        aliases: ["NVDA"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      kpiContext: {
        template: "semis",
        required: ["revenue_growth_yoy"],
        optional: [],
        selected: ["revenue_growth_yoy", "profit_margin"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 1,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.readThroughQualityV2?.issuerAnchorPresent).toBeTrue();
    const nonIssuerIncluded =
      (saved?.diagnostics?.readThroughQualityV2?.peerIncluded ?? 0) +
      (saved?.diagnostics?.readThroughQualityV2?.supplyChainIncluded ?? 0) +
      (saved?.diagnostics?.readThroughQualityV2?.customerIncluded ?? 0) +
      (saved?.diagnostics?.readThroughQualityV2?.industryIncluded ?? 0);
    expect(nonIssuerIncluded).toBeLessThanOrEqual(4);
    expect(
      saved?.diagnostics?.newsQualityV2?.excludedByReason.read_through_capped ??
        0,
    ).toBeGreaterThan(0);
  });

  it("drops non-issuer read-through when no issuer anchor survives thresholds", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-peer-1",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "peer-1",
        type: "news",
        title: "Peer competitor guidance and revenue growth signal",
        summary: "peer demand and margin context",
        content:
          "peer competitor next earnings guidance update revenue_growth_yoy profit_margin demand margin litigation regulation contract launch capacity expansion remains strong.",
        url: "https://example.com/non-issuer-only",
        publishedAt: new Date("2026-02-17T09:00:00.000Z"),
        language: "en",
        topics: ["industry-news"],
        sourceType: "api",
        rawPayload: { related: "AMD" },
        createdAt: new Date("2026-02-17T09:00:00.000Z"),
      },
    ];

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok(noEvidenceThesis),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "NVDA",
      resolvedIdentity: {
        requestedSymbol: "NVDA",
        canonicalSymbol: "NVDA",
        companyName: "NVIDIA Corporation",
        aliases: ["NVDA"],
        confidence: 0.99,
        resolutionSource: "manual_map",
      },
      kpiContext: {
        template: "semis",
        required: ["revenue_growth_yoy"],
        optional: [],
        selected: ["revenue_growth_yoy", "profit_margin"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 1,
      },
    });

    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.readThroughQualityV2?.issuerAnchorPresent).toBeFalse();
    expect(
      saved?.diagnostics?.newsQualityV2?.excludedByReason
        .read_through_without_issuer_anchor ?? 0,
    ).toBeGreaterThan(0);
  });

  it("applies deterministic fallback when thesis quality remains below floor after repair", async () => {
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

    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok("watch and monitor developments"),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run(payload);
    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.thesisQuality?.fallbackApplied).toBeTrue();
    expect(saved?.thesis).toContain("# Action Summary");
    expect(saved?.thesis).toContain("# Evidence Map");
    expect(saved?.thesis).toContain("# Missing Evidence");
    expect(saved?.thesis).toContain("# Conclusion");
  });

  it("uses evidence-checkpoint fallback language for insufficient_evidence mode", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-1",
        type: "news",
        title: "TTWO operating update",
        summary: "TTWO update",
        content: "TTWO update details",
        url: "https://example.com/ttwo-fallback",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async () => ok("watch and monitor developments"),
    };
    const { service, savedSnapshots } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
    });

    await service.run(payload);
    const saved = savedSnapshots[0];
    expect(saved?.diagnostics?.thesisQuality?.fallbackApplied).toBeTrue();
    expect(saved?.investorViewV2?.action.decision).toBe("insufficient_evidence");
    expect(saved?.thesis).toContain("- Decision: Insufficient Evidence");
    expect(saved?.thesis).toContain("evidence checkpoints");
    expect(saved?.thesis).not.toContain("upgrade one notch");
    expect(saved?.thesis).not.toContain("downgrade one notch");
    expect(saved?.diagnostics?.fallbackReasonCodes?.length ?? 0).toBeGreaterThan(0);
    expect(saved?.investorViewV2?.confidence.thesisConfidence ?? 0).toBeLessThanOrEqual(50);
    expect(saved?.investorViewV2?.confidence.timingConfidence ?? 0).toBeLessThanOrEqual(60);
  });

  it("injects cross-run memory into prompt and excludes current run from retrieval", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-1",
        symbol: "TTWO",
        provider: "finnhub",
        providerItemId: "f-1",
        type: "news",
        title: "TTWO growth momentum headline",
        summary: "Growth update",
        content: "TTWO saw new momentum.",
        url: "https://example.com/ttwo-memory-seed",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["growth"],
        sourceType: "api",
        rawPayload: { related: "TTWO" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];

    let capturedExcludeRunId: string | undefined;
    let capturedFrom: Date | undefined;
    const memoryRepo: EmbeddingMemoryRepositoryPort = {
      findSimilarBySymbol: async (_symbol, _queryEmbedding, options) => {
        capturedExcludeRunId = options.excludeRunId;
        capturedFrom = options.from;
        return [
          {
            documentId: "historical-doc-1",
            symbol: "TTWO",
            runId: "old-run",
            content: "Prior run context around growth durability and margin sensitivity.",
            similarity: 0.81,
            createdAt: new Date("2026-01-20T00:00:00.000Z"),
          },
        ];
      },
    };

    const prompts: string[] = [];
    const llm: LlmPort = {
      summarize: async () => ok(""),
      synthesize: async (prompt) => {
        prompts.push(prompt);
        return ok(validThesis);
      },
    };

    const { service } = createService({
      docs,
      metrics: [],
      filings: [],
      llm,
      memoryRepo,
      now: new Date("2026-02-17T12:00:00.000Z"),
    });

    await service.run(payload);

    expect(prompts[0]).toContain("Cross-run memory (semantic matches, prior runs):");
    expect(prompts[0]).toContain("R1 run=old-run similarity=0.810");
    expect(capturedExcludeRunId).toBe("run-1");
    expect(capturedFrom?.toISOString()).toBe("2025-11-19T12:00:00.000Z");
  });

  it("selects template-relevant macro metrics and persists macro diagnostics", async () => {
    const docs: DocumentEntity[] = [
      {
        id: "doc-macro-1",
        symbol: "NVDA",
        provider: "finnhub",
        providerItemId: "macro-1",
        type: "news",
        title: "NVDA demand update",
        summary: "Issuer update",
        content: "NVDA demand remained strong.",
        url: "https://example.com/nvda-demand",
        publishedAt: new Date("2026-02-17T08:00:00.000Z"),
        language: "en",
        topics: ["company-news"],
        sourceType: "api",
        rawPayload: { related: "NVDA" },
        createdAt: new Date("2026-02-17T08:00:00.000Z"),
      },
    ];

    const metrics: MetricPointEntity[] = [
      {
        id: "metric-1",
        symbol: "NVDA",
        provider: "alphavantage",
        metricName: "revenue_growth_yoy",
        metricValue: 0.22,
        metricUnit: "ratio",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "quarter",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "macro-1",
        symbol: "NVDA",
        provider: "fred",
        metricName: "macro_industrial_production_yoy",
        metricValue: 2.5,
        metricUnit: "pct",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "macro-2",
        symbol: "NVDA",
        provider: "fred",
        metricName: "macro_us10y_yield",
        metricValue: 4.2,
        metricUnit: "pct",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "macro-3",
        symbol: "NVDA",
        provider: "fred",
        metricName: "macro_cpi_yoy",
        metricValue: 3.1,
        metricUnit: "pct",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
      },
      {
        id: "macro-4",
        symbol: "NVDA",
        provider: "fred",
        metricName: "macro_fed_funds_rate",
        metricValue: 4.5,
        metricUnit: "pct",
        currency: "USD",
        asOf: new Date("2026-02-16T00:00:00.000Z"),
        periodType: "point_in_time",
        rawPayload: {},
        createdAt: new Date("2026-02-16T00:00:00.000Z"),
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
      filings: [],
      llm,
    });

    await service.run({
      ...payload,
      symbol: "NVDA",
      kpiContext: {
        template: "semis",
        required: ["revenue_growth_yoy"],
        optional: [],
        selected: ["revenue_growth_yoy"],
        requiredHitCount: 1,
        minRequiredForStrongNote: 1,
      },
      macroContextDiagnostics: {
        totalMetricCount: 4,
        providers: [
          {
            provider: "fred",
            status: "ok",
            metricCount: 4,
          },
          {
            provider: "bls",
            status: "empty",
            metricCount: 0,
          },
        ],
      },
    });

    expect(prompts[0]).toContain("Macro context (sector-sensitive):");
    expect(prompts[0]).toContain("macro_industrial_production_yoy");
    expect(prompts[0]).toContain("macro_us10y_yield");
    expect(prompts[0]).toContain("macro_cpi_yoy");
    expect(prompts[0]).not.toContain("macro_fed_funds_rate");

    const saved = savedSnapshots.at(0);
    expect(saved?.diagnostics?.macroContext?.totalMetricCount).toBe(4);
    expect(saved?.diagnostics?.macroContext?.selectedForTemplate).toEqual([
      "macro_industrial_production_yoy",
      "macro_us10y_yield",
      "macro_cpi_yoy",
    ]);
  });
});
