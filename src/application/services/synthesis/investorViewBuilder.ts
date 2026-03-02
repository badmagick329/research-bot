import type { DocumentEntity } from "../../../core/entities/document";
import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type {
  ConfidenceDecomposition,
  EvidenceGateDiagnostics,
  InvestorKpi,
} from "../../../core/entities/research";
import type { SynthesisInvestorViewBuilderPort } from "./types";

/**
 * Builds investor-view projections from deterministic synthesis outputs.
 */
export class SynthesisInvestorViewBuilder
  implements SynthesisInvestorViewBuilderPort
{
  constructor(
    private readonly computeConfidence: (
      docs: DocumentEntity[],
      metrics: MetricPointEntity[],
      filings: FilingEntity[],
      now: Date,
      relevanceCoverage: number,
    ) => number,
    private readonly formatMetricValue: (metric: MetricPointEntity) => string,
  ) {}

  /**
   * Decomposes confidence into data/thesis/timing components.
   */
  buildConfidenceDecomposition(args: {
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    now: Date;
    relevanceCoverage: number;
    horizonScore: number;
    evidenceGate: EvidenceGateDiagnostics;
    fallbackApplied: boolean;
    issuerAnchorCount: number;
  }): ConfidenceDecomposition {
    const dataConfidence = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          this.computeConfidence(
            args.selectedDocs,
            args.metrics,
            args.filings,
            args.now,
            args.relevanceCoverage,
          ) * 100,
        ),
      ),
    );

    let thesisConfidence = Math.round(
      (args.evidenceGate.passed ? 62 : 38) +
        Math.min(18, args.metrics.length * 2) +
        Math.min(10, args.filings.length * 3),
    );
    if (!args.evidenceGate.passed) {
      thesisConfidence = Math.min(thesisConfidence, 40);
    }
    if (args.fallbackApplied) {
      thesisConfidence = Math.min(thesisConfidence, 50);
    }
    if (args.issuerAnchorCount < 2) {
      thesisConfidence = Math.min(thesisConfidence, 55);
    }

    let timingConfidence = Math.max(
      0,
      Math.min(
        100,
        Math.round(args.horizonScore + Math.min(12, args.selectedDocs.length * 2)),
      ),
    );
    if (args.fallbackApplied) {
      timingConfidence = Math.min(timingConfidence, 60);
    }
    if (args.issuerAnchorCount < 2) {
      timingConfidence = Math.min(timingConfidence, 65);
    }

    return {
      dataConfidence,
      thesisConfidence: Math.max(0, Math.min(100, thesisConfidence)),
      timingConfidence,
    };
  }

  /**
   * Converts selected KPI names into investor-facing KPI cards.
   */
  buildInvestorKpis(
    selectedKpiNames: string[],
    metricLabelByName: Map<string, string>,
    metrics: MetricPointEntity[],
  ): InvestorKpi[] {
    const byName = new Map(metrics.map((metric) => [metric.metricName, metric]));
    return selectedKpiNames.slice(0, 10).flatMap((name) => {
      const metric = byName.get(name);
      const label = metricLabelByName.get(name);
      if (!metric || !label) {
        return [];
      }

      const value = this.formatMetricValue(metric);
      if (value === "n/a") {
        return [];
      }

      const trend: InvestorKpi["trend"] = name.includes("growth")
        ? "up"
        : name.includes("volatility")
          ? "mixed"
          : "unknown";
      return [
        {
          name,
          value,
          trend,
          whyItMatters: `Tracks ${name.replace(/_/g, " ")} as a core thesis checkpoint.`,
          evidenceRefs: [label],
        },
      ];
    });
  }

  /**
   * Resolves catalyst evidence refs with deterministic fallback when selected news is sparse.
   */
  resolveCatalystEvidenceRefs(args: {
    index: number;
    selectedNewsLabels: string[];
    metricCount: number;
    filingCount: number;
  }): string[] {
    if (args.selectedNewsLabels.length > 0) {
      const label =
        args.selectedNewsLabels[
          Math.min(args.index, Math.max(0, args.selectedNewsLabels.length - 1))
        ];
      return label ? [label] : [];
    }

    if (args.metricCount > 0) {
      return [`M${(args.index % args.metricCount) + 1}`];
    }

    if (args.filingCount > 0) {
      return [`F${(args.index % args.filingCount) + 1}`];
    }

    return [];
  }
}
