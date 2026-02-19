import { err, ok, type Result } from "neverthrow";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type {
  CompanyResolveRequest,
  CompanyResolveResult,
  CompanyResolverPort,
} from "../../../core/ports/inboundPorts";

type ManualIdentityRecord = {
  companyName: string;
  aliases: string[];
  exchange?: string;
};

const TICKER_PATTERN = /^[A-Z0-9.\-]{1,12}$/;

const MANUAL_IDENTITY_MAP: Record<string, ManualIdentityRecord> = {
  RYCEY: {
    companyName: "Rolls-Royce Holdings plc",
    aliases: ["RYCEY", "RR.L"],
    exchange: "OTC",
  },
  "RR.L": {
    companyName: "Rolls-Royce Holdings plc",
    aliases: ["RYCEY", "RR.L"],
    exchange: "LSE",
  },
  "ROLLS ROYCE": {
    companyName: "Rolls-Royce Holdings plc",
    aliases: ["RYCEY", "RR.L"],
    exchange: "OTC",
  },
  "ROLLS-ROYCE": {
    companyName: "Rolls-Royce Holdings plc",
    aliases: ["RYCEY", "RR.L"],
    exchange: "OTC",
  },
  "ROLLS-ROYCE HOLDINGS PLC": {
    companyName: "Rolls-Royce Holdings plc",
    aliases: ["RYCEY", "RR.L"],
    exchange: "OTC",
  },
};

/**
 * Resolves user-provided symbols into canonical identity metadata so downstream stages stay issuer-grounded.
 */
export class CompanyResolver implements CompanyResolverPort {
  /**
   * Uses a deterministic map-first strategy so known aliases resolve consistently without provider variance.
   */
  async resolveCompany(
    request: CompanyResolveRequest,
  ): Promise<Result<CompanyResolveResult, AppBoundaryError>> {
    const normalized = request.symbolOrName.trim().toUpperCase();

    if (!normalized) {
      return err({
        source: "resolver",
        code: "validation_error",
        provider: "company-resolver",
        message: "Company resolution requires a non-empty symbol or name.",
        retryable: false,
      });
    }

    const mapped = MANUAL_IDENTITY_MAP[normalized];
    if (mapped) {
      const canonicalSymbol = mapped.aliases.includes(normalized)
        ? normalized
        : (mapped.aliases[0] ?? normalized);
      return ok({
        identity: {
          requestedSymbol: normalized,
          canonicalSymbol,
          companyName: mapped.companyName,
          aliases: Array.from(
            new Set(mapped.aliases.map((alias) => alias.toUpperCase())),
          ),
          exchange: mapped.exchange,
          confidence: 0.99,
          resolutionSource: "manual_map",
        },
      });
    }

    if (TICKER_PATTERN.test(normalized)) {
      return ok({
        identity: {
          requestedSymbol: normalized,
          canonicalSymbol: normalized,
          companyName: normalized,
          aliases: [normalized],
          confidence: 0.4,
          resolutionSource: "heuristic",
        },
      });
    }

    return err({
      source: "resolver",
      code: "validation_error",
      provider: "company-resolver",
      message: `Unable to resolve '${request.symbolOrName}' to a ticker. Provide a valid ticker symbol such as RYCEY or RR.L.`,
      retryable: false,
    });
  }
}
