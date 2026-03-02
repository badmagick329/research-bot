import { describe, expect, it } from "bun:test";
import type { ResearchSnapshotEntity } from "../../../core/entities/research";
import {
  getKpiTemplate,
  mapTemplateFromThesisType,
  resolveTemplateFromSnapshot,
} from "./kpiCatalog";

const baseSnapshot = (): ResearchSnapshotEntity => ({
  id: "snapshot-1",
  runId: "run-1",
  taskId: "task-1",
  symbol: "NVDA",
  horizon: "1_2_quarters",
  score: 71,
  thesis: "x",
  risks: [],
  catalysts: [],
  valuationView: "Neutral",
  confidence: 0.6,
  sources: [],
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  investorViewV2: {
    thesisType: "compounder",
    action: {
      decision: "watch",
      positionSizing: "small",
    },
    horizon: {
      bucket: "1_2_quarters",
      rationale: "x",
    },
    summary: {
      oneLineThesis: "x",
    },
    variantView: {
      pricedInNarrative: "x",
      ourVariant: "x",
      whyMispriced: "x",
    },
    drivers: [],
    keyKpis: [],
    catalysts: [],
    falsification: [],
    valuation: {
      valuationFramework: "x",
      keyMultiples: [],
      historyContext: "x",
      peerContext: "x",
      valuationView: "fair",
    },
    confidence: {
      dataConfidence: 50,
      thesisConfidence: 50,
      timingConfidence: 50,
    },
  },
});

describe("kpiCatalog", () => {
  it("returns a deterministic fallback template", () => {
    expect(getKpiTemplate("generic").name).toBe("generic");
  });

  it("maps thesis type hints to template hints", () => {
    expect(mapTemplateFromThesisType("compounder")).toBe("software_saas");
    expect(mapTemplateFromThesisType("turnaround")).toBe("semis");
    expect(mapTemplateFromThesisType("unclear")).toBeNull();
  });

  it("selects overlap template and keeps insufficient-evidence fallback generic", () => {
    const snapshot = baseSnapshot();
    const byOverlap = resolveTemplateFromSnapshot(snapshot, [
      "revenue_growth_yoy",
      "gross_margin",
      "peer_rev_growth_percentile",
    ]);
    expect(byOverlap.name).toBe("semis");

    if (!snapshot.investorViewV2) {
      throw new Error("expected investor view");
    }
    snapshot.investorViewV2.action.decision = "insufficient_evidence";
    const fallback = resolveTemplateFromSnapshot(snapshot, ["unknown_signal"]);
    expect(fallback.name).toBe("generic");
  });
});
