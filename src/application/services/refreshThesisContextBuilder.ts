import type {
  KpiTemplateContext,
  ResearchSnapshotEntity,
} from "../../core/entities/research";
import type { JobPayload } from "../../core/ports/outboundPorts";
import { resolveTemplateFromSnapshot } from "./shared/kpiCatalog";

/**
 * Rebuilds KPI context from snapshot evidence so synthesize-only refresh preserves Stage-1 quality gates without schema changes.
 */
const rebuildKpiContextFromSnapshot = (
  snapshot: ResearchSnapshotEntity,
): KpiTemplateContext | undefined => {
  const selected = Array.from(
    new Set(snapshot.investorViewV2?.keyKpis.map((kpi) => kpi.name) ?? []),
  );
  if (!snapshot.investorViewV2 || selected.length === 0) {
    return undefined;
  }

  const template = resolveTemplateFromSnapshot(snapshot, selected);
  const requiredHitCount = template.required.filter((name) =>
    selected.includes(name),
  ).length;

  return {
    template: template.name,
    required: template.required,
    optional: template.optional,
    selected,
    requiredHitCount,
    minRequiredForStrongNote: template.minRequiredForStrongNote,
  };
};

/**
 * Builds one synthesize payload from snapshot state so API/CLI refresh paths stay behaviorally identical.
 */
export const buildRefreshThesisPayload = (
  snapshot: ResearchSnapshotEntity,
  normalizedSymbol: string,
  idempotencyKey: string,
): JobPayload => ({
  runId: snapshot.runId ?? "",
  taskId: snapshot.taskId ?? "",
  symbol: normalizedSymbol,
  idempotencyKey,
  requestedAt: new Date().toISOString(),
  resolvedIdentity: snapshot.diagnostics?.identity,
  metricsDiagnostics: snapshot.diagnostics?.metrics,
  metricsCompanyFactsDiagnostics: snapshot.diagnostics?.metricsCompanyFacts,
  providerFailures: snapshot.diagnostics?.providerFailures,
  stageIssues: snapshot.diagnostics?.stageIssues,
  thesisTypeContext: snapshot.investorViewV2
    ? {
        thesisType: snapshot.investorViewV2.thesisType,
        reasonCodes: ["refresh_from_snapshot"],
        score: 50,
      }
    : undefined,
  horizonContext:
    snapshot.horizon === "0_4_weeks" ||
    snapshot.horizon === "1_2_quarters" ||
    snapshot.horizon === "1_3_years"
      ? {
          horizon: snapshot.horizon,
          rationale:
            "Restored from latest snapshot context during synthesize-only refresh.",
          score: 50,
        }
      : undefined,
  kpiContext: rebuildKpiContextFromSnapshot(snapshot),
  evidenceGate: snapshot.diagnostics?.evidenceGate,
});
