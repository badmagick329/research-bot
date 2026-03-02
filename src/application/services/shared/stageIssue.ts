import type { AppBoundaryError } from "../../../core/entities/appError";
import type { SnapshotStageDiagnostics } from "../../../core/entities/research";
import type { JobPayload } from "../../../core/ports/outboundPorts";

/**
 * Appends a stage issue to payload diagnostics so downstream stages can report degradation context.
 */
export const appendStageIssue = (
  payload: JobPayload,
  issue: SnapshotStageDiagnostics,
): JobPayload => ({
  ...payload,
  stageIssues: [...(payload.stageIssues ?? []), issue],
});

/**
 * Converts boundary errors into stable stage diagnostics with consistent reason formatting.
 */
export const toBoundaryStageIssue = (args: {
  stage: SnapshotStageDiagnostics["stage"];
  summary: string;
  error: AppBoundaryError;
}): SnapshotStageDiagnostics => ({
  stage: args.stage,
  status: "degraded",
  reason: `${args.summary} due to ${args.error.provider}: ${args.error.message}`,
  provider: args.error.provider,
  code: args.error.code,
  retryable: args.error.retryable,
});
