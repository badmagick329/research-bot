import { describe, expect, it } from "bun:test";
import { CompanyResolver } from "./companyResolver";

describe("CompanyResolver", () => {
  it("resolves RYCEY to Rolls-Royce identity", async () => {
    const resolver = new CompanyResolver();

    const result = await resolver.resolveCompany({ symbolOrName: "RYCEY" });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.identity).toEqual({
      requestedSymbol: "RYCEY",
      canonicalSymbol: "RYCEY",
      companyName: "Rolls-Royce Holdings plc",
      aliases: ["RYCEY", "RR.L"],
      exchange: "OTC",
      confidence: 0.99,
      resolutionSource: "manual_map",
    });
  });

  it("returns heuristic identity for unknown ticker-shaped symbols", async () => {
    const resolver = new CompanyResolver();

    const result = await resolver.resolveCompany({ symbolOrName: "ABCD" });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.identity).toEqual({
      requestedSymbol: "ABCD",
      canonicalSymbol: "ABCD",
      companyName: "ABCD",
      aliases: ["ABCD"],
      confidence: 0.4,
      resolutionSource: "heuristic",
    });
  });

  it("resolves Rolls-Royce company name to canonical RYCEY identity", async () => {
    const resolver = new CompanyResolver();

    const result = await resolver.resolveCompany({
      symbolOrName: "rolls royce",
    });

    expect(result.isOk()).toBeTrue();
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.identity.canonicalSymbol).toBe("RYCEY");
    expect(result.value.identity.companyName).toBe("Rolls-Royce Holdings plc");
    expect(result.value.identity.aliases).toEqual(["RYCEY", "RR.L"]);
  });

  it("returns validation error for unresolved non-ticker inputs", async () => {
    const resolver = new CompanyResolver();

    const result = await resolver.resolveCompany({
      symbolOrName: "completely unknown issuer name",
    });

    expect(result.isErr()).toBeTrue();
    if (result.isErr()) {
      expect(result.error.source).toBe("resolver");
      expect(result.error.code).toBe("validation_error");
    }
  });
});
