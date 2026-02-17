/**
 * Shared date utilities for provider adapters.
 * Extracted to avoid duplication across multiple providers.
 */

/**
 * Converts a Date to ISO date string (YYYY-MM-DD format).
 * Used for API query parameters that expect date-only strings.
 */
export const toIsoDate = (value: Date): string =>
  value.toISOString().slice(0, 10);
