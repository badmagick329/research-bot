/**
 * Central option lists for config enum-like fields.
 * Keeping values in one place avoids drift between defaults, validation, and editor IntelliSense.
 */
export const supportedNewsProviders = ["mock", "finnhub", "alphavantage"] as const;
export const supportedMetricsProviders = ["mock", "alphavantage"] as const;
export const supportedFilingsProviders = ["mock", "sec-edgar"] as const;
export const supportedLlmProviders = ["ollama", "openai"] as const;
export const supportedNewsRelevanceModes = ["high_precision", "balanced"] as const;
export const supportedNewsV2SourceQualityModes = ["default"] as const;

export type NewsProviderName = (typeof supportedNewsProviders)[number];
export type MetricsProviderName = (typeof supportedMetricsProviders)[number];
export type FilingsProviderName = (typeof supportedFilingsProviders)[number];
export type LlmProviderName = (typeof supportedLlmProviders)[number];
export type NewsRelevanceModeName = (typeof supportedNewsRelevanceModes)[number];
export type NewsV2SourceQualityModeName =
  (typeof supportedNewsV2SourceQualityModes)[number];
