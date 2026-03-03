import type { DocumentEntity } from "../../../core/entities/document";
import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type { ActionDecision } from "../../../core/entities/research";
import type {
  RelevanceSelection,
  SynthesisThesisGuardPort,
  ThesisCheckpoint,
  ThesisQualityScore,
} from "./types";

/**
 * Implements lightweight thesis validation and conservative fallback behavior so investor notes stay business-facing.
 */
export class DeterministicSynthesisThesisGuard implements SynthesisThesisGuardPort {
  constructor(
    private readonly thesisTriggerMinNumeric: number,
    private readonly thesisMinCitationCoveragePct: number,
    private readonly thesisGenericPhraseMax: number,
    private readonly formatMetricValue: (metric: MetricPointEntity) => string,
  ) {}

  /**
   * Rewrites evidence map section to deterministic mapping.
   */
  upsertEvidenceMapSection(thesis: string, evidenceMapLines: string): string {
    const evidenceMapSection = `# Evidence Map\n\n${evidenceMapLines}`;
    const sections = thesis
      .trim()
      .split(/\n(?=# )/g)
      .map((section) => section.trim())
      .filter(Boolean);
    const withoutEvidenceMap = sections.filter(
      (section) => !section.toLowerCase().startsWith("# evidence map"),
    );
    return [...withoutEvidenceMap, evidenceMapSection].join("\n\n").trim();
  }

  /**
   * Aligns markdown decision wording with final action decision in the Decision section only.
   */
  upsertFinalDecisionPresentation(
    thesis: string,
    decision: ActionDecision,
  ): string {
    const decisionLabel =
      decision === "buy"
        ? "Buy"
        : decision === "avoid"
          ? "Avoid"
          : decision === "insufficient_evidence"
            ? "Insufficient Evidence"
            : "Watch";
    if (/# Action Summary/i.test(thesis)) {
      const updated = thesis.replace(
        /(^-?\s*\*{0,2}decision\*{0,2}:\s*)(.*)$/im,
        `$1${decisionLabel}`,
      );
      return updated;
    }
    if (!/# Decision/i.test(thesis)) {
      return `${thesis.trim()}\n\n# Decision\n- ${decisionLabel}`;
    }
    const section = this.extractHeadingSection(thesis, "Decision");
    if (!section) {
      return thesis;
    }
    const replacement = `# Decision\n- ${decisionLabel}`;
    return thesis.replace(/# Decision\n[\s\S]*?(?=\n# |\s*$)/i, `${replacement}\n`);
  }

  /**
   * Validates synthesis output for section completeness, citation hygiene, and internal-jargon leakage.
   */
  validateThesis(
    thesis: string,
    hasEvidence: boolean,
    shouldForceIdentityUncertainty: boolean,
    _evidenceWeak: boolean,
    _memoryCount: number,
    selectedKpiNames: string[],
  ): string[] {
    const issues: string[] = [];
    const usesLegacyLayout = thesis.includes("# Action Summary");
    const requiredHeadings = usesLegacyLayout
      ? [
          "# Action Summary",
          "# Overview",
          "# Valuation and Growth Interpretation",
          "# Regulatory Filings",
          "# Missing Evidence",
          "# Conclusion",
        ]
      : [
          "# Thesis Type",
          "# Horizon and Why",
          "# One-line Thesis",
          "# What Seems Priced In",
          "# Variant View",
          "# Top Business Drivers",
          "# Top KPIs and Why They Matter",
          "# Catalysts",
          "# Falsifiers",
          "# Valuation View",
          "# Decision",
        ];

    requiredHeadings.forEach((heading) => {
      if (!thesis.includes(heading)) {
        issues.push(`Missing heading: ${heading}`);
      }
    });

    const bannedTerms = [
      "normalized signal",
      "signal count",
      "fresh signal count",
      "coverage threshold",
      "invariant",
      "compiled trigger",
      "trigger matrix",
      "policy gate",
      "repair pass",
      "fallback mechanics",
      "sufficiency check",
      "stage issue",
      "mentions_regulatory_action",
    ];
    const lower = `${this.extractHeadingSection(thesis, "Falsifiers") ?? ""}\n${this.extractHeadingSection(thesis, "Decision") ?? ""}`.toLowerCase();
    bannedTerms.forEach((term) => {
      if (lower.includes(term)) {
        issues.push(`Contains internal-system term: ${term}`);
      }
    });

    if (!usesLegacyLayout) {
      const oneLineSection = this.extractHeadingSection(thesis, "One-line Thesis");
      if (!oneLineSection || oneLineSection.length < 40) {
        issues.push("One-line thesis is too generic or missing.");
      } else if (
        /\b(attractive|supports|available evidence|normalized|signal sufficiency)\b/i.test(
          oneLineSection,
        )
      ) {
        issues.push("One-line thesis is generic.");
      }
      const normalizedOneLine = (oneLineSection ?? "").toLowerCase();
      const hasKpiMention = selectedKpiNames.some((name) => {
        const normalized = name.toLowerCase().replace(/_/g, " ");
        return normalizedOneLine.includes(normalized);
      });
      if (selectedKpiNames.length > 0 && !hasKpiMention) {
        issues.push("One-line thesis must reference at least one selected KPI.");
      }
      const hasBusinessDriver = /\b(revenue|margin|demand|pricing|volume|cash flow|backlog|utilization|segment|execution|customer)\b/i.test(
        normalizedOneLine,
      );
      if (!hasBusinessDriver) {
        issues.push("One-line thesis must include a business driver.");
      }
    }

    const kpiSection = usesLegacyLayout
      ? this.extractHeadingSection(thesis, "Valuation and Growth Interpretation")
      : this.extractHeadingSection(thesis, "Top KPIs and Why They Matter");
    const kpiBullets = (kpiSection ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line));
    if (kpiBullets.length < 2) {
      issues.push("At least two KPI entries are required.");
    }
    const valuationLike = kpiBullets.filter((line) => /\b(pe|p\/e|pb|p\/b|market cap|ev\/)\b/i.test(line)).length;
    if (kpiBullets.length > 0 && valuationLike >= kpiBullets.length) {
      issues.push("KPI section is valuation-only.");
    }

    const falsifiers = this.extractHeadingSection(thesis, "Falsifiers");
    if ((falsifiers ?? "").length > 0 && /normalized|signal|coverage|compiled trigger|invariant/i.test(falsifiers ?? "")) {
      issues.push("Falsifiers contain internal-system wording.");
    }
    const catalysts = this.extractHeadingSection(thesis, "Catalysts");
    const hasCheckpointLanguage = (value: string | null): boolean =>
      /\b(earnings|filing|guidance|launch|contract|approval|margin|revenue|cash flow|backlog|demand)\b/i.test(
        value ?? "",
      );
    const hasSelectedKpiReference = (value: string | null): boolean =>
      selectedKpiNames.some((name) =>
        (value ?? "")
          .toLowerCase()
          .includes(name.toLowerCase().replace(/_/g, " ")),
      );
    if (!usesLegacyLayout) {
      if ((falsifiers ?? "").length > 0 && !hasCheckpointLanguage(falsifiers) && !hasSelectedKpiReference(falsifiers)) {
        issues.push("Falsifiers must reference selected KPIs or business checkpoints.");
      }
      if ((catalysts ?? "").length > 0 && !hasCheckpointLanguage(catalysts) && !hasSelectedKpiReference(catalysts)) {
        issues.push("Catalysts must reference selected KPIs or business checkpoints.");
      }
    }

    if (hasEvidence) {
      const citations = thesis.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/g) ?? [];
      if (citations.length < 4) {
        issues.push("Citation density is too low for available evidence.");
      }
    }

    if (!shouldForceIdentityUncertainty && /(placeholder|unknown identifier)/i.test(thesis)) {
      issues.push("Contains forbidden identity wording despite sufficient identity confidence.");
    }

    return Array.from(new Set(issues));
  }

  /**
   * Scores thesis quality to determine if conservative fallback note is required.
   */
  scoreThesisQuality(
    thesis: string,
    validationIssues: string[],
    hasEvidence: boolean,
  ): ThesisQualityScore {
    let score = 100;
    const failedChecks = [...validationIssues];

    const genericMatches = thesis.match(/\b(watch for|monitor|could|may|stay tuned)\b/gi) ?? [];
    if (genericMatches.length > this.thesisGenericPhraseMax) {
      failedChecks.push(
        `generic_phrase_count_${genericMatches.length}_gt_${this.thesisGenericPhraseMax}`,
      );
      score -= (genericMatches.length - this.thesisGenericPhraseMax) * 8;
    }

    if (hasEvidence) {
      const diagnostics = this.computeCitationDiagnostics(thesis);
      if (diagnostics.citationCoveragePct < this.thesisMinCitationCoveragePct) {
        failedChecks.push(
          `low_citation_coverage_${diagnostics.citationCoveragePct}_lt_${this.thesisMinCitationCoveragePct}`,
        );
        score -= 20;
      }
    }

    score -= Math.min(50, validationIssues.length * 8);
    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      failedChecks: Array.from(new Set(failedChecks)).slice(0, 20),
    };
  }

  /**
   * Builds a short conservative fallback note that avoids fake precision when synthesis quality is insufficient.
   */
  buildDeterministicFallbackThesis(args: {
    actionDecision: ActionDecision;
    checkpoints: ThesisCheckpoint[];
    evidenceMapLines: string;
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    relevanceSelection: RelevanceSelection;
  }): string {
    const decisionLabel =
      args.actionDecision === "avoid"
        ? "Avoid"
        : args.actionDecision === "buy"
          ? "Watch"
          : args.actionDecision === "insufficient_evidence"
            ? "Insufficient Evidence"
            : "Watch";
    const primaryCitation =
      args.checkpoints.flatMap((item) => item.evidenceRefs).at(0) ?? "M1";
    const topMetrics = args.metrics
      .slice(0, 3)
      .map((metric, index) => `- ${metric.metricName}: ${this.formatMetricValue(metric)} [M${index + 1}]`)
      .join("\n");
    const latestFiling = args.filings[0];
    const filingLine = latestFiling
      ? `- Latest filing context: ${latestFiling.filingType} filed ${latestFiling.filedAt.toISOString().slice(0, 10)} [F1]`
      : "- Latest filing context: limited recent filings";

    return [
      "# Thesis Type",
      "- unclear [M1]",
      "",
      "# Horizon and Why",
      "- 1_2_quarters: evidence is limited, so next earnings checkpoints matter most [M1]",
      "",
      "# One-line Thesis",
      "- Evidence quality is currently too thin to make a differentiated directional call [M1]",
      "",
      "# What Seems Priced In",
      "- Current pricing appears to assume stable execution without a clear upside surprise [M1]",
      "",
      "# Variant View",
      "- Variant edge is weak until KPI trends and filings provide stronger confirmation [M1]",
      "",
      "# Top Business Drivers",
      "- Revenue durability and margin trajectory remain the central business drivers [M1]",
      "",
      "# Top KPIs and Why They Matter",
      topMetrics || "- revenue_growth_yoy: unavailable [M1]",
      "",
      "# Catalysts",
      "- No high-conviction catalyst identified from current evidence set",
      "",
      "# Falsifiers",
      "- Revenue growth slows over the next two quarters without margin offset [M1]",
      "- Material legal/regulatory pressure changes the risk profile [F1]",
      "",
      "# Valuation View",
      "- Valuation is secondary until business KPI direction is clearer [M1]",
      "",
      "# Decision",
      `- ${decisionLabel} [${primaryCitation}]`,
      "",
      "# Evidence Map",
      args.evidenceMapLines,
      "",
      "# Missing Evidence",
      filingLine,
      `- Selected issuer-linked headlines: ${args.selectedDocs.length} [${primaryCitation}]`,
      `- Excluded/noisy headlines: ${args.relevanceSelection.excludedHeadlinesCount} [${primaryCitation}]`,
    ].join("\n");
  }

  /**
   * Computes citation linkage diagnostics for persisted snapshot diagnostics.
   */
  computeCitationDiagnostics(thesis: string): {
    citationCoveragePct: number;
    unlinkedClaimsCount: number;
  } {
    const claimLines = thesis
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- ") && line.length > 8);
    if (claimLines.length === 0) {
      return {
        citationCoveragePct: 100,
        unlinkedClaimsCount: 0,
      };
    }
    const linked = claimLines.filter((line) =>
      /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(line),
    );
    const citationCoveragePct = Math.round((linked.length / claimLines.length) * 100);
    return {
      citationCoveragePct,
      unlinkedClaimsCount: claimLines.length - linked.length,
    };
  }

  /**
   * Extracts markdown section body by heading for section-specific checks.
   */
  private extractHeadingSection(thesis: string, heading: string): string | null {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`# ${escapedHeading}\\n([\\s\\S]*?)(\\n# |$)`, "i");
    const match = thesis.match(regex);
    return match?.[1]?.trim() ?? null;
  }
}
