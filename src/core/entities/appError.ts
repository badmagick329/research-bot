/**
 * Describes canonical error categories used at clean-architecture boundaries.
 */
export type AppBoundaryErrorCode =
  | "timeout"
  | "rate_limited"
  | "auth_invalid"
  | "config_invalid"
  | "provider_error"
  | "transport_error"
  | "malformed_response"
  | "invalid_json"
  | "validation_error"
  | "dimension_mismatch";

/**
 * Describes a normalized boundary failure while preserving adapter/provider provenance.
 */
export type AppBoundaryError = {
  source: "news" | "metrics" | "filings" | "llm" | "embedding";
  code: AppBoundaryErrorCode;
  provider: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  cause?: unknown;
};
