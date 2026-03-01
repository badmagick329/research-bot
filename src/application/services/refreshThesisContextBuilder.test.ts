import { describe, expect, it } from "bun:test";
import { buildRefreshThesisPayload } from "./refreshThesisContextBuilder";
import type { ResearchSnapshotEntity } from "../../core/entities/research";

const buildBaseSnapshot = (): ResearchSnapshotEntity => ({
  id: "snapshot-1",
  runId: "run-1",
  taskId: "task-1",
  symbol: "NVDA",
  horizon: "1_2_quarters",
  score: 72,
  thesis: "thesis",
  risks: [],
  catalysts: [],
  valuationView: "Neutral",
  confidence: 0.75,
  sources: [],
  createdAt: new Date("2026-03-01T10:00:00.000Z"),
  investorViewV2: {
    thesisType: "compounder",
    action: { decision: "watch", positionSizing: "small" },
    horizon: { bucket: "1_2_quarters", rationale: "test" },
    summary: { oneLineThesis: "test" },
    variantView: {
      pricedInNarrative: "test",
      ourVariant: "test",
      whyMispriced: "test",
    },
    drivers: [],
    keyKpis: [],
    catalysts: [],
    falsification: [],
    valuation: {
      valuationFramework: "test",
      keyMultiples: [],
      historyContext: "test",
      peerContext: "test",
      valuationView: "fair",
    },
    confidence: {
      dataConfidence: 70,
      thesisConfidence: 70,
      timingConfidence: 70,
    },
  },
});

describe("buildRefreshThesisPayload", () => {
  it("rebuilds non-generic kpi context when snapshot KPI overlap is strong", () => {
    const snapshot = buildBaseSnapshot();
    if (!snapshot.investorViewV2) {
      throw new Error("expected investor view");
    }
    snapshot.investorViewV2.keyKpis = [
      {
        name: "revenue_growth_yoy",
        value: "0.22",
        trend: "up",
        whyItMatters: "test",
        evidenceRefs: ["M1"],
      },
      {
        name: "gross_margin",
        value: "0.55",
        trend: "up",
        whyItMatters: "test",
        evidenceRefs: ["M2"],
      },
      {
        name: "peer_rev_growth_percentile",
        value: "78",
        trend: "up",
        whyItMatters: "test",
        evidenceRefs: ["M3"],
      },
    ];

    const payload = buildRefreshThesisPayload(snapshot, "NVDA", "idemp-1");

    expect(payload.kpiContext?.template).toBe("semis");
    expect(payload.kpiContext?.required.length).toBeGreaterThan(0);
    expect(payload.kpiContext?.optional.length).toBeGreaterThan(0);
    expect(payload.kpiContext?.selected).toEqual([
      "revenue_growth_yoy",
      "gross_margin",
      "peer_rev_growth_percentile",
    ]);
    expect(payload.kpiContext?.requiredHitCount).toBe(2);
  });

  it("falls back to generic template for sparse insufficient-evidence snapshots", () => {
    const snapshot = buildBaseSnapshot();
    if (!snapshot.investorViewV2) {
      throw new Error("expected investor view");
    }
    snapshot.investorViewV2.action.decision = "insufficient_evidence";
    snapshot.investorViewV2.keyKpis = [
      {
        name: "custom_signal_not_mapped",
        value: "1",
        trend: "unknown",
        whyItMatters: "test",
        evidenceRefs: ["M1"],
      },
    ];

    const payload = buildRefreshThesisPayload(snapshot, "NVDA", "idemp-2");

    expect(payload.kpiContext?.template).toBe("generic");
    expect(payload.kpiContext?.required).toEqual([
      "revenue_growth_yoy",
      "price_to_earnings",
      "eps",
    ]);
    expect(payload.kpiContext?.selected).toEqual(["custom_signal_not_mapped"]);
  });
});
