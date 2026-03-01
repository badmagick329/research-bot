import { describe, expect, it } from "bun:test";
import { formatSnapshotReport } from "./main";
import type { ResearchSnapshotEntity } from "../core/entities/research";

/**
 * Builds a minimal but complete snapshot fixture so CLI report tests can validate investor-first rendering.
 */
const createSnapshot = (): ResearchSnapshotEntity => ({
  id: "snapshot-1",
  runId: "run-1",
  taskId: "task-1",
  symbol: "AMZN",
  horizon: "1_2_quarters",
  score: 72.5,
  thesis: "# Action Summary\n- Decision: Watch [M1]",
  risks: ["Execution risk"],
  catalysts: ["Next earnings"],
  valuationView: "Neutral",
  confidence: 0.8,
  sources: [{ provider: "finnhub", title: "AMZN update", url: "https://example.com/amzn" }],
  investorViewV2: {
    thesisType: "compounder",
    action: {
      decision: "watch",
      positionSizing: "small",
    },
    horizon: {
      bucket: "1_2_quarters",
      rationale: "Next two earnings cycles are key checkpoints.",
    },
    summary: {
      oneLineThesis: "Growth remains durable but valuation needs confirmation.",
    },
    variantView: {
      pricedInNarrative: "Market expects sustained growth momentum.",
      ourVariant: "Execution likely remains solid but upside needs fresh catalysts.",
      whyMispriced: "Expectations may already discount near-term growth.",
    },
    drivers: [],
    keyKpis: [
      {
        name: "revenue_growth_yoy",
        value: "0.16",
        trend: "up",
        whyItMatters: "Growth durability drives rerating potential.",
        evidenceRefs: ["M1"],
      },
    ],
    catalysts: [
      {
        event: "Next earnings",
        window: "next 1-2 quarters",
        expectedDirection: "confirm or weaken growth durability",
        whyItMatters: "Confirms execution trajectory.",
        evidenceRefs: ["F1"],
      },
    ],
    falsification: [
      {
        condition: "If revenue growth falls below 10%",
        type: "numeric",
        thresholdOrOutcome: "10%",
        deadline: "next earnings cycle",
        actionIfHit: "reduce exposure",
        evidenceRefs: ["M1"],
      },
    ],
    valuation: {
      valuationFramework: "multiples + growth durability + filing context",
      keyMultiples: ["price_to_earnings=29.0"],
      historyContext: "Compared versus recent history",
      peerContext: "Compared versus peer median",
      valuationView: "fair",
    },
    confidence: {
      dataConfidence: 82,
      thesisConfidence: 61,
      timingConfidence: 59,
    },
  },
  diagnostics: {
    issuerMatchDiagnostics: {
      title: 2,
      summary: 1,
      content: 1,
      payload: 3,
      payloadOnlyRejected: 1,
    },
    fallbackReasonCodes: ["thesis_quality_below_floor_63_lt_75"],
  },
  createdAt: new Date("2026-03-01T17:45:54.395Z"),
});

describe("formatSnapshotReport", () => {
  it("renders investor view first and hides raw thesis by default", () => {
    const report = formatSnapshotReport(createSnapshot());
    expect(report).toContain("Investor view:");
    expect(report).toContain("- Thesis type: compounder");
    expect(report).toContain("- Confidence decomposition:");
    expect(report).not.toContain("Thesis (raw markdown):");
    expect(report).not.toContain("\nCatalysts:\n");
  });

  it("renders raw thesis when showRawThesis is enabled", () => {
    const report = formatSnapshotReport(createSnapshot(), { showRawThesis: true });
    expect(report).toContain("Thesis (raw markdown):");
    expect(report).toContain("# Action Summary");
  });

  it("renders top-level catalysts when investor view is absent", () => {
    const snapshot = createSnapshot();
    snapshot.investorViewV2 = undefined;
    const report = formatSnapshotReport(snapshot);
    expect(report).toContain("\nCatalysts:\n");
    expect(report).toContain("- Next earnings");
  });
});
