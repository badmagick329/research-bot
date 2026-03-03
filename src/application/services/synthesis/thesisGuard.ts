import type { DocumentEntity } from "../../../core/entities/document";
import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type { ActionDecision } from "../../../core/entities/research";
import type {
  ActionMatrixRow,
  RelevanceSelection,
  SynthesisThesisGuardPort,
  ThesisDecision,
  ThesisQualityScore,
} from "./types";

/**
 * Implements deterministic thesis validation, scoring, and fallback generation.
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

    const filteredSections = sections.filter(
      (section) => !section.toLowerCase().startsWith("# evidence map"),
    );

    const mergedSections: string[] = [];
    let inserted = false;

    filteredSections.forEach((section) => {
      if (!inserted && section.toLowerCase().startsWith("# overview")) {
        mergedSections.push(evidenceMapSection);
        inserted = true;
      }
      mergedSections.push(section);
    });

    if (!inserted) {
      const actionSummaryIndex = mergedSections.findIndex((section) =>
        section.toLowerCase().startsWith("# action summary"),
      );
      if (actionSummaryIndex >= 0) {
        mergedSections.splice(actionSummaryIndex + 1, 0, evidenceMapSection);
      } else {
        mergedSections.unshift(evidenceMapSection);
      }
    }

    return mergedSections.join("\n\n").trim();
  }

  /**
   * Rewrites action-summary decision and trigger block to deterministic policy.
   */
  upsertActionSummaryDeterminism(
    thesis: string,
    decision: ThesisDecision,
    actionMatrix: ActionMatrixRow[],
  ): string {
    const section = this.extractHeadingSection(thesis, "Action Summary");
    if (!section) {
      return thesis;
    }

    const decisionLabel = decision.charAt(0).toUpperCase() + decision.slice(1);
    const firstCitation = actionMatrix.flatMap((row) => row.citations).at(0) ?? "M1";
    const decisionLine = `- Decision: ${decisionLabel} [${firstCitation}]`;
    const triggerLines = actionMatrix
      .slice(0, 5)
      .map(
        (row) =>
          `  - If ${row.condition.replace(/^If\s+/i, "")}, ${row.action} [${row.citations.join("] [")}]`,
      )
      .join("\n");

    const lines = section.split("\n");
    const rebuilt: string[] = [];
    let decisionInjected = false;
    let triggerInjected = false;
    let skippingTriggerBody = false;
    const labelRegex =
      /^(?:-\s*)?(?:\*\*)?(Reasons to invest:|Reasons to stay away:|If\/Then triggers:|Thesis invalidation:)(?:\*\*)?/i;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const labelMatch = line.match(labelRegex);
      if (labelMatch) {
        const label = (labelMatch[1] ?? "").toLowerCase();

        if (label.includes("if/then triggers")) {
          rebuilt.push("- If/Then triggers:");
          rebuilt.push(triggerLines);
          triggerInjected = true;
          skippingTriggerBody = true;
          continue;
        }

        skippingTriggerBody = false;
      }

      if (skippingTriggerBody) {
        if (labelRegex.test(line)) {
          skippingTriggerBody = false;
        } else {
          continue;
        }
      }

      if (/^-?\s*\*{0,2}decision\*{0,2}:/i.test(line)) {
        rebuilt.push(decisionLine);
        decisionInjected = true;
        continue;
      }

      rebuilt.push(rawLine);
    }

    if (!decisionInjected) {
      rebuilt.splice(0, 0, decisionLine);
    }
    if (!triggerInjected) {
      const idx = rebuilt.findIndex((line) => /thesis invalidation:/i.test(line));
      if (idx >= 0) {
        rebuilt.splice(idx, 0, "- If/Then triggers:", triggerLines);
      } else {
        rebuilt.push("- If/Then triggers:", triggerLines);
      }
    }

    const updatedSection = rebuilt.join("\n");

    return thesis.replace(
      /# Action Summary\n[\s\S]*?(?=\n# |\s*$)/i,
      `# Action Summary\n${updatedSection}\n`,
    );
  }

  /**
   * Aligns markdown decision wording with final action decision.
   */
  upsertFinalDecisionPresentation(
    thesis: string,
    decision: ActionDecision,
    actionMatrix: ActionMatrixRow[],
  ): string {
    const firstCitation = actionMatrix.flatMap((row) => row.citations).at(0) ?? "M1";
    const decisionLabel =
      decision === "buy"
        ? "Buy"
        : decision === "avoid"
          ? "Avoid"
          : decision === "watch_low_quality"
            ? "Watch (Low Quality)"
            : decision === "insufficient_evidence"
              ? "Insufficient Evidence"
              : "Watch";
    const decisionLine = `- Decision: ${decisionLabel} [${firstCitation}]`;

    const section = this.extractHeadingSection(thesis, "Action Summary");
    if (!section) {
      return thesis;
    }

    const updatedSection = section
      .split("\n")
      .map((line) =>
        /^-?\s*\*{0,2}decision\*{0,2}:/i.test(line.trim()) ? decisionLine : line,
      )
      .join("\n");

    let rewritten = thesis.replace(
      /# Action Summary\n[\s\S]*?(?=\n# |\s*$)/i,
      `# Action Summary\n${updatedSection}\n`,
    );

    if (/^# Conclusion[\s\S]*$/im.test(rewritten)) {
      rewritten = rewritten.replace(
        /(Decision remains )(Buy|Watch|Avoid|Watch \(Low Quality\)|Insufficient Evidence)(\b)/i,
        `$1${decisionLabel}$3`,
      );
    }

    return rewritten;
  }

  /**
   * Validates synthesis output structure and citation/actionability quality constraints.
   */
  validateThesis(
    thesis: string,
    hasEvidence: boolean,
    shouldForceIdentityUncertainty: boolean,
    evidenceWeak: boolean,
    memoryCount: number,
  ): string[] {
    const issues: string[] = [];

    const requiredHeadings = [
      "# Action Summary",
      "# Evidence Map",
      "# Overview",
      "# Shareholder/Institutional Dynamics",
      "# Valuation and Growth Interpretation",
      "# Regulatory Filings",
      "# Missing Evidence",
      "# Conclusion",
    ];

    requiredHeadings.forEach((heading) => {
      if (!thesis.includes(heading)) {
        issues.push(`Missing heading: ${heading}`);
      }
    });
    if (
      thesis.includes("# Action Summary") &&
      thesis.includes("# Evidence Map") &&
      thesis.includes("# Overview") &&
      (thesis.indexOf("# Action Summary") > thesis.indexOf("# Evidence Map") ||
        thesis.indexOf("# Evidence Map") > thesis.indexOf("# Overview"))
    ) {
      issues.push("Heading order must be Action Summary, Evidence Map, then Overview.");
    }

    const actionSummarySection = this.extractHeadingSection(thesis, "Action Summary");
    const evidenceMapSection = this.extractHeadingSection(thesis, "Evidence Map");
    if (!actionSummarySection) {
      issues.push("Action Summary section content is missing.");
    }

    const parsedDecisionLine = this.parseDecisionLine(actionSummarySection);
    const decision = parsedDecisionLine.decision;
    if (!decision) {
      issues.push(
        "Action Summary Decision must be Buy, Watch, Avoid, Watch (Low Quality), or Insufficient Evidence.",
      );
    } else if (evidenceWeak && decision !== "watch") {
      issues.push("Weak evidence must default Decision to Watch.");
    }

    const requiredActionLabels = [
      "Reasons to invest:",
      "Reasons to stay away:",
      "If/Then triggers:",
      "Thesis invalidation:",
    ];
    requiredActionLabels.forEach((label) => {
      if (!actionSummarySection || !actionSummarySection.includes(label)) {
        issues.push(`Missing Action Summary label: ${label}`);
      }
    });

    if (!evidenceMapSection) {
      issues.push("Evidence Map section content is missing.");
    } else {
      const labelMentions =
        evidenceMapSection.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/g) ?? [];
      if (hasEvidence && labelMentions.length < 3) {
        issues.push("Evidence Map must include traceable citation labels.");
      }
      if (hasEvidence && !/\bM\d+\b/.test(evidenceMapSection)) {
        issues.push("Evidence Map must include metric label mappings (M#).");
      }
    }

    const citationMatches = thesis.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/g) ?? [];
    if (hasEvidence && citationMatches.length < 4) {
      issues.push("Citation density is too low for available evidence.");
    }

    if (actionSummarySection && hasEvidence) {
      const actionSummaryCitations =
        actionSummarySection.match(/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/g) ?? [];
      if (actionSummaryCitations.length < 4) {
        issues.push("Action Summary citation density is too low.");
      }
    }

    if (hasEvidence && parsedDecisionLine.raw && !parsedDecisionLine.hasCitation) {
      issues.push("Action Summary Decision line must include evidence citation.");
    }
    if (parsedDecisionLine.raw && parsedDecisionLine.hasGenericLanguage) {
      issues.push("Action Summary Decision line uses generic placeholder language.");
    }

    const memoryCitations = thesis.match(/\bR\d+\b/g) ?? [];
    if (hasEvidence && memoryCitations.length > 0 && citationMatches.length === 0) {
      issues.push("Current-run evidence exists, but thesis relies only on memory citations.");
    }

    if (
      hasEvidence &&
      memoryCount > 0 &&
      !/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(thesis)
    ) {
      issues.push(
        "Directional narrative must anchor to current-run evidence when memory is present.",
      );
    }

    const triggerLines = this.extractActionSubBullets(
      actionSummarySection,
      "If/Then triggers:",
    );
    if (triggerLines.length < 3 || triggerLines.length > 5) {
      issues.push("If/Then triggers must include between 3 and 5 sub-bullets.");
    }
    triggerLines.forEach((line) => {
      const normalized = line.toLowerCase();
      if (!normalized.includes("if ") || !normalized.includes(" then ")) {
        issues.push(`Trigger must be conditional (If ... then ...): ${line}`);
      }
      if (!/\d/.test(normalized) && !/(true|false)/.test(normalized)) {
        issues.push(`Trigger missing numeric or boolean threshold: ${line}`);
      }
      if (!/(upgrade|downgrade|add|reduce|hold|re-evaluate)/.test(normalized)) {
        issues.push(`Trigger missing explicit action verb: ${line}`);
      }
      const downsideCondition =
        /\b(deteriorates|moves below|falls below|drops below|declines below|becomes true)\b/.test(
          normalized,
        );
      const additiveAction = /\b(add|upgrade)\b/.test(normalized);
      if (downsideCondition && additiveAction) {
        issues.push(`Trigger action contradicts downside condition: ${line}`);
      }
      if (
        normalized.includes("monitor developments") ||
        normalized.includes("watch news") ||
        normalized.includes("stay tuned") ||
        normalized.includes("watch for") ||
        normalized.includes("monitor") ||
        /\bcould\b/.test(normalized) ||
        /\bmay\b/.test(normalized)
      ) {
        issues.push(`Trigger is too generic: ${line}`);
      }
      if (hasEvidence && !/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(line)) {
        issues.push(`Trigger missing citation: ${line}`);
      }
    });

    if (hasEvidence) {
      const sections = thesis
        .split("# ")
        .map((block) => block.trim())
        .filter(Boolean);
      sections.forEach((section) => {
        if (!/\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+)\b/.test(section)) {
          issues.push(`Section missing citation: ${section.split("\n")[0]}`);
        }
      });
    }

    const uncertaintyLineCount = thesis
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.includes("uncertain") || line.includes("missing evidence"))
      .length;
    if (uncertaintyLineCount > 6) {
      issues.push("Uncertainty language is repetitive across sections.");
    }

    const forbiddenIdentityPattern = /(placeholder|unknown identifier)/i;
    if (!shouldForceIdentityUncertainty && forbiddenIdentityPattern.test(thesis)) {
      issues.push(
        "Contains forbidden identity wording despite sufficient identity confidence.",
      );
    }

    return issues;
  }

  /**
   * Scores thesis quality to decide whether deterministic fallback is required.
   */
  scoreThesisQuality(
    thesis: string,
    validationIssues: string[],
    hasEvidence: boolean,
  ): ThesisQualityScore {
    const failedChecks = [...validationIssues];
    let score = 100;

    const triggerLines = this.extractActionSubBullets(
      this.extractHeadingSection(thesis, "Action Summary"),
      "If/Then triggers:",
    );
    if (triggerLines.length < 3) {
      failedChecks.push("insufficient_trigger_count");
      score -= 20;
    }

    const numericOrBooleanTriggerCount = triggerLines.filter(
      (line) => /\d/.test(line) || /(true|false)/i.test(line),
    ).length;
    if (numericOrBooleanTriggerCount < this.thesisTriggerMinNumeric) {
      failedChecks.push("insufficient_numeric_or_boolean_triggers");
      score -= 15;
    }

    const actionableLines = thesis
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          /^-\s+/.test(line) &&
          !/^-\s+(Reasons to|If\/Then triggers:|Thesis invalidation:|Decision:|Timeframe fit:)/i.test(
            line,
          ),
      );
    const citedActionableCount = actionableLines.filter((line) =>
      /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(line),
    ).length;
    const citationCoveragePct =
      actionableLines.length === 0
        ? 100
        : Math.round((citedActionableCount / actionableLines.length) * 100);
    if (hasEvidence && citationCoveragePct < this.thesisMinCitationCoveragePct) {
      failedChecks.push(
        `low_citation_coverage_${citationCoveragePct}_lt_${this.thesisMinCitationCoveragePct}`,
      );
      score -= 15;
    }

    const genericPattern = /\b(watch for|monitor|stay tuned|could|may)\b/gi;
    const thesisWithoutEvidenceMap = thesis.replace(
      /# Evidence Map\n[\s\S]*?(?=\n# |\s*$)/i,
      "# Evidence Map\n",
    );
    const genericMatches = thesisWithoutEvidenceMap.match(genericPattern) ?? [];
    if (genericMatches.length > this.thesisGenericPhraseMax) {
      failedChecks.push(
        `generic_phrase_count_${genericMatches.length}_gt_${this.thesisGenericPhraseMax}`,
      );
      score -= (genericMatches.length - this.thesisGenericPhraseMax) * 8;
    }

    const parsedDecisionLine = this.parseDecisionLine(
      this.extractHeadingSection(thesis, "Action Summary"),
    );
    const hasDecisionValidationIssue = validationIssues.some((issue) =>
      issue.toLowerCase().includes("decision"),
    );
    if (
      !parsedDecisionLine.raw ||
      !parsedDecisionLine.decision ||
      (hasEvidence && !parsedDecisionLine.hasCitation)
    ) {
      if (!hasDecisionValidationIssue) {
        failedChecks.push("weak_or_uncited_decision_line");
      }
      score -= 8;
    }

    const uniqueValidationIssues = Array.from(new Set(validationIssues));
    score -= Math.min(28, uniqueValidationIssues.length * 5);
    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      failedChecks: Array.from(new Set(failedChecks)).slice(0, 20),
    };
  }

  /**
   * Builds deterministic fallback thesis when generated draft quality remains below floor.
   */
  buildDeterministicFallbackThesis(args: {
    actionDecision: ActionDecision;
    actionMatrix: ActionMatrixRow[];
    evidenceMapLines: string;
    selectedDocs: DocumentEntity[];
    metrics: MetricPointEntity[];
    filings: FilingEntity[];
    relevanceSelection: RelevanceSelection;
  }): string {
    const decisionLabel =
      args.actionDecision === "buy"
        ? "Buy"
        : args.actionDecision === "avoid"
          ? "Avoid"
          : args.actionDecision === "watch_low_quality"
            ? "Watch (Low Quality)"
            : args.actionDecision === "insufficient_evidence"
              ? "Insufficient Evidence"
              : "Watch";
    const citations = args.actionMatrix.flatMap((row) => row.citations).filter(Boolean);
    const primaryCitation = citations[0] ?? "M1";
    const triggerRows =
      args.actionMatrix.length > 0
        ? args.actionMatrix.slice(0, 3)
        : [
            {
              condition: "If signal coverage remains below 3",
              triggerKind: "coverage",
              conditionDirection: "neutral",
              actionClass: "neutral",
              action: "then re-evaluate decision confidence",
              citations: [primaryCitation],
            },
          ];
    const triggerLines = triggerRows
      .map(
        (row) =>
          `  - If ${row.condition.replace(/^If\s+/i, "").replace(/\.$/, "")}, ${row.action} (${row.citations.join(", ")})`,
      )
      .join("\n");

    const metricNames = new Set(args.metrics.map((metric) => metric.metricName));
    const missingFields = ["revenue_growth_yoy", "price_to_earnings", "analyst_buy_ratio"].filter(
      (name) => !metricNames.has(name),
    );

    return [
      "# Action Summary",
      `- Decision: ${decisionLabel} [${primaryCitation}]`,
      `- Timeframe fit: Short-term (0-3m) signal-gated; Long-term (12m+) conviction only with sustained evidence [${primaryCitation}]`,
      "- Reasons to invest:",
      `  - Deterministic signal set indicates measurable upside conditions only when trigger thresholds are met [${primaryCitation}]`,
      `  - Current run includes ${args.metrics.length} metrics, ${args.filings.length} filings, and ${args.selectedDocs.length} issuer-linked headlines [${primaryCitation}]`,
      "- Reasons to stay away:",
      `  - Evidence quality can degrade when excluded/noisy headlines remain high (${args.relevanceSelection.excludedHeadlinesCount}) [${primaryCitation}]`,
      `  - Missing structured fields lower conviction: ${missingFields.length > 0 ? missingFields.join(", ") : "none"} [${primaryCitation}]`,
      "- If/Then triggers:",
      triggerLines,
      "- Thesis invalidation:",
      `  - If two or more core evidence checkpoints fail in sequence, then reduce risk exposure (${primaryCitation})`,
      `  - If filing risk facts switch to true (regulatory or risk-factor flags), then reduce risk exposure (${primaryCitation})`,
      "",
      "# Evidence Map",
      args.evidenceMapLines,
      "",
      "# Overview",
      `Current fallback note reflects structured evidence only; directional conviction remains tied to numeric sufficiency and filing checkpoints [${primaryCitation}].`,
      "",
      "# Shareholder/Institutional Dynamics",
      `Shareholder positioning is treated as secondary context until numeric sufficiency and filing confirmation improve [${primaryCitation}].`,
      "",
      "# Valuation and Growth Interpretation",
      `Valuation and growth interpretation remains conditional on refreshed KPI signals and trigger outcomes [${primaryCitation}].`,
      "",
      "# Regulatory Filings",
      `Filing facts are retained as hard stop conditions for risk control and thesis invalidation [${primaryCitation}].`,
      "",
      "# Missing Evidence",
      `Missing deterministic fields: ${missingFields.length > 0 ? missingFields.join(", ") : "none"} [${primaryCitation}].`,
      "",
      "# Conclusion",
      `Decision remains ${decisionLabel} until sufficiency gaps close and trigger thresholds can be re-tested [${primaryCitation}].`,
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
   * Parses one decision line into normalized action + citation/generic-language checks.
   */
  private parseDecisionLine(actionSummarySection: string | null): {
    raw: string | null;
    decision: ActionDecision | null;
    hasCitation: boolean;
    hasGenericLanguage: boolean;
  } {
    if (!actionSummarySection) {
      return {
        raw: null,
        decision: null,
        hasCitation: false,
        hasGenericLanguage: false,
      };
    }

    const raw =
      actionSummarySection.split("\n").find((line) => /decision:/i.test(line)) ??
      null;
    if (!raw) {
      return {
        raw: null,
        decision: null,
        hasCitation: false,
        hasGenericLanguage: false,
      };
    }

    const normalized = raw.toLowerCase();
    let decision: ActionDecision | null = null;
    if (/decision:\s*watch\s*\(low quality\)\b/i.test(raw)) {
      decision = "watch_low_quality";
    } else if (/decision:\s*insufficient evidence\b/i.test(raw)) {
      decision = "insufficient_evidence";
    } else if (/decision:\s*buy\b/i.test(raw)) {
      decision = "buy";
    } else if (/decision:\s*avoid\b/i.test(raw)) {
      decision = "avoid";
    } else if (/decision:\s*watch\b/i.test(raw)) {
      decision = "watch";
    }

    return {
      raw,
      decision,
      hasCitation: /\b(?:N(?:_[a-z_]+)?\d+|M\d+|F\d+|R\d+)\b/.test(raw),
      hasGenericLanguage: /(watch for|monitor|stay tuned|could\b|may\b)/i.test(
        normalized,
      ),
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

  /**
   * Collects sub-bullets under a labeled action block.
   */
  private extractActionSubBullets(
    actionSummarySection: string | null,
    label: string,
  ): string[] {
    if (!actionSummarySection) {
      return [];
    }

    const lines = actionSummarySection.split("\n");
    const labelIndex = lines.findIndex((line) => line.includes(label));
    if (labelIndex < 0) {
      return [];
    }

    const bullets: string[] = [];
    for (let index = labelIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (!line) {
        continue;
      }

      if (
        /^(?:-\s+)?(?:Reasons to invest:|Reasons to stay away:|If\/Then triggers:|Thesis invalidation:)/i.test(
          line,
        )
      ) {
        break;
      }

      if (/^[-*]\s+/.test(line)) {
        bullets.push(line);
      } else {
        break;
      }
    }

    return bullets;
  }
}
