import { ok, type Result } from "neverthrow";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type {
  MacroContextFetchResult,
  MacroContextProviderPort,
  MacroContextRequest,
  MacroContextFetchDiagnostics,
} from "../../../core/ports/inboundPorts";

/**
 * Composes multiple macro providers while preserving per-provider diagnostics for non-fatal degradation.
 */
export class MultiMacroProvider implements MacroContextProviderPort {
  constructor(private readonly providers: MacroContextProviderPort[]) {}

  /**
   * Fetches all macro providers and returns merged metrics plus diagnostics for both successes and failures.
   */
  async fetchMacroContext(
    request: MacroContextRequest,
  ): Promise<Result<MacroContextFetchResult, AppBoundaryError>> {
    const metrics: MacroContextFetchResult["metrics"] = [];
    const diagnostics: MacroContextFetchDiagnostics[] = [];

    const responses = await Promise.all(
      this.providers.map(async (provider) => provider.fetchMacroContext(request)),
    );

    responses.forEach((response) => {
      if (response.isOk()) {
        metrics.push(...response.value.metrics);
        diagnostics.push(...response.value.diagnostics);
        return;
      }

      diagnostics.push({
        provider: response.error.provider === "bls" ? "bls" : "fred",
        status: this.mapErrorStatus(response.error.code),
        metricCount: 0,
        reason: response.error.message,
        httpStatus: response.error.httpStatus,
      });
    });

    return ok({
      metrics,
      diagnostics,
    });
  }

  /**
   * Maps boundary errors to diagnostics statuses so ingestion can track degradation without failing the run.
   */
  private mapErrorStatus(
    code: AppBoundaryError["code"],
  ): MacroContextFetchDiagnostics["status"] {
    switch (code) {
      case "rate_limited":
      case "timeout":
      case "auth_invalid":
      case "config_invalid":
      case "provider_error":
      case "transport_error":
      case "malformed_response":
      case "invalid_json":
        return code;
      default:
        return "provider_error";
    }
  }
}
