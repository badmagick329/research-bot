import { describe, expect, it } from "bun:test";
import { SynthesisInvestorViewBuilder } from "./investorViewBuilder";

describe("SynthesisInvestorViewBuilder", () => {
  it("prefers selected news labels for catalyst refs", () => {
    const builder = new SynthesisInvestorViewBuilder(
      () => 0.7,
      () => "1.00",
    );
    const refs = builder.resolveCatalystEvidenceRefs({
      index: 1,
      selectedNewsLabels: ["N_issuer1", "N_peer1"],
      metricCount: 3,
      filingCount: 1,
    });
    expect(refs).toEqual(["N_peer1"]);
  });

  it("falls back to metric refs when selected news is empty", () => {
    const builder = new SynthesisInvestorViewBuilder(
      () => 0.7,
      () => "1.00",
    );
    const refs = builder.resolveCatalystEvidenceRefs({
      index: 0,
      selectedNewsLabels: [],
      metricCount: 2,
      filingCount: 1,
    });
    expect(refs).toEqual(["M1"]);
  });
});
