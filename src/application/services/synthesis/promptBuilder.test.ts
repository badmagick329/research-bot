import { describe, expect, it } from "bun:test";
import { SynthesisPromptBuilder } from "./promptBuilder";

describe("SynthesisPromptBuilder", () => {
  it("formats empty memory deterministically", () => {
    const builder = new SynthesisPromptBuilder(() => "1.00");
    expect(builder.formatMemoryLines([])).toBe("- none");
  });

  it("builds repair prompt with listed issues", () => {
    const builder = new SynthesisPromptBuilder(() => "1.00");
    const prompt = builder.buildRepairPrompt("base", "draft", [
      "Missing heading",
      "Missing citation",
    ]);
    expect(prompt).toContain("Validation failures:");
    expect(prompt).toContain("- Missing heading");
    expect(prompt).toContain("- Missing citation");
  });
});
