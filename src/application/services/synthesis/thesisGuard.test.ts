import { describe, expect, it } from "bun:test";
import { DeterministicSynthesisThesisGuard } from "./thesisGuard";

describe("DeterministicSynthesisThesisGuard", () => {
  it("injects deterministic evidence map section", () => {
    const guard = new DeterministicSynthesisThesisGuard(3, 80, 0, () => "1.00");
    const thesis = `# Action Summary\n- Decision: Watch [M1]\n\n# Overview\nBody`;
    const rewritten = guard.upsertEvidenceMapSection(
      thesis,
      '- N_issuer1: news "A"',
    );
    expect(rewritten).toContain("# Evidence Map");
    expect(rewritten).toContain('- N_issuer1: news "A"');
  });

  it("reports missing headings for invalid thesis", () => {
    const guard = new DeterministicSynthesisThesisGuard(3, 80, 0, () => "1.00");
    const issues = guard.validateThesis("short text", true, false, false, 0, []);
    expect(issues.some((issue) => issue.includes("Missing heading"))).toBeTrue();
  });
});
