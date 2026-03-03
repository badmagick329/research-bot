import type { DocumentEntity } from "../../../core/entities/document";
import type { FilingEntity } from "../../../core/entities/filing";
import type { MetricPointEntity } from "../../../core/entities/metric";
import type { EmbeddingMemoryMatch } from "../../../core/ports/outboundPorts";
import type { SynthesisPromptBuilderPort, ThesisDecision } from "./types";
import type { RelevanceSelection } from "./types";

/**
 * Builds synthesis prompt contracts and deterministic evidence-map text for stable LLM behavior.
 */
export class SynthesisPromptBuilder implements SynthesisPromptBuilderPort {
  constructor(
    private readonly formatMetricValue: (metric: MetricPointEntity) => string,
  ) {}

  /**
   * Builds the synthesis prompt contract for first-pass generation with investor-note sections and explicit bans on internal pipeline jargon.
   */
  buildSynthesisPrompt(args: {
    synthesisTarget: string;
    identityLines: string;
    metricsDiagnosticsLine: string;
    providerFailureLines: string;
    stageIssueLines: string;
    sourceLines: string;
    metricLines: string;
    macroLines: string;
    filingLines: string;
    memoryLines: string;
    decisionFromContext: ThesisDecision;
    decisionReasonLines: string;
    relevanceSelection: RelevanceSelection;
    shouldForceIdentityUncertainty: boolean;
    evidenceWeak: boolean;
  }): string {
    const relevanceCoverage =
      args.relevanceSelection.selected.length === 0
        ? "0/0"
        : `${args.relevanceSelection.selectedRelevantCount}/${args.relevanceSelection.selected.length}`;

    return [
      `Create an investing thesis for ${args.synthesisTarget}.`,
      "Use only the evidence below.",
      "Do not invent facts, numbers, shareholders, or events not present in evidence.",
      "When evidence is missing or weak, explicitly state uncertainty and data gaps.",
      "Cite each major claim with one or more evidence labels (N_<class>#, M#, F#).",
      "Avoid internal pipeline language in investor-facing prose.",
      "If unsure, be conservative and prefer watch/insufficient-evidence framing.",
      "",
      "Resolved company identity:",
      args.identityLines,
      "",
      "Metrics fetch diagnostics:",
      args.metricsDiagnosticsLine,
      "",
      "Provider failures:",
      args.providerFailureLines,
      "",
      "Pipeline stage issues:",
      args.stageIssueLines,
      "",
      "News relevance diagnostics (diagnostics only, do not reference directly in note prose):",
      `- relevantHeadlinesCount=${args.relevanceSelection.relevantHeadlinesCount}`,
      `- relevanceCoverage=${relevanceCoverage}`,
      `- lowRelevance=${args.relevanceSelection.lowRelevance}`,
      `- evidenceWeak=${args.evidenceWeak}`,
      `- totalHeadlines=${args.relevanceSelection.totalHeadlinesCount}`,
      `- issuerMatchedHeadlines=${args.relevanceSelection.issuerMatchedHeadlinesCount}`,
      `- excludedHeadlines=${args.relevanceSelection.excludedHeadlinesCount}`,
      `- includedHeadlines=${args.relevanceSelection.selected.length}`,
      `- averageCompositeScore=${args.relevanceSelection.averageCompositeScore}`,
      `- prefilterClassCountsBefore=${Object.entries(args.relevanceSelection.prefilterClassCountsBefore)
        .map(([name, count]) => `${name}:${count}`)
        .join(",")}`,
      `- prefilterClassCountsAfter=${Object.entries(args.relevanceSelection.prefilterClassCountsAfter)
        .map(([name, count]) => `${name}:${count}`)
        .join(",")}`,
      `- issuerAnchorAvailable=${args.relevanceSelection.issuerAnchorAvailable}`,
      `- issuerAnchorAvailableCount=${args.relevanceSelection.issuerAnchorAvailableCount}`,
      `- issuerAnchorSelectedCount=${args.relevanceSelection.issuerAnchorCount}`,
      Object.keys(args.relevanceSelection.excludedByReason).length > 0
        ? `- excludedByReason=${Object.entries(args.relevanceSelection.excludedByReason)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(",")}`
        : "- excludedByReason=none",
      args.relevanceSelection.excludedHeadlineReasonSamples.length > 0
        ? `- excludedSample=${args.relevanceSelection.excludedHeadlineReasonSamples.join(" | ")}`
        : "- excludedSample=none",
      args.relevanceSelection.excludedHeadlineReasons.length > 0
        ? `- excludedReasons=${args.relevanceSelection.excludedHeadlineReasons.slice(0, 8).join(",")}`
        : "- excludedReasons=none",
      "",
      "News headlines:",
      args.sourceLines || "- none",
      "",
      "Market metrics:",
      args.metricLines || "- none",
      "",
      "Macro context (sector-sensitive):",
      args.macroLines || "- none",
      "",
      "Regulatory filings:",
      args.filingLines || "- none",
      "",
      "Cross-run memory (semantic matches, prior runs):",
      args.memoryLines,
      "",
      "Deterministic decision seed:",
      `- decision=${args.decisionFromContext}`,
      args.decisionReasonLines,
      "",
      "Output requirements:",
      "- Return Markdown with these headings in order:",
      "  # Thesis Type",
      "  # Horizon and Why",
      "  # One-line Thesis",
      "  # What Seems Priced In",
      "  # Variant View",
      "  # Top Business Drivers",
      "  # Top KPIs and Why They Matter",
      "  # Catalysts",
      "  # Falsifiers",
      "  # Valuation View",
      "  # Decision",
      "- Keep each section concise and business-specific.",
      "- One-line thesis must include one business driver, one horizon-relevant condition, and one stock implication.",
      "- Include 3-5 KPIs with interpretation; at least two must be operational or financial business KPIs (not valuation ratios).",
      "- Include at most 2 catalysts and at most 2 falsifiers. Do not fabricate if evidence is weak.",
      "- Use R# memory references only as supporting context, never as primary support for a buy call.",
      "- Mention macro only when it is directly thesis-critical; otherwise keep macro context out of the investor note.",
      "- If evidenceWeak=true, default decision to Watch or Insufficient Evidence unless contradiction is strong.",
      "- Do not mention internal mechanics such as normalized signals, sufficiency checks, trigger matrix, policy gates, repair passes, fallback mechanics, evidence coverage counters, stage issues, or compiled triggers.",
      "- Avoid generic filler language like 'monitor', 'could', 'may', or 'watch for' without a concrete business condition.",
      "- Treat listed aliases as the same issuer unless evidence explicitly contradicts this.",
      args.shouldForceIdentityUncertainty
        ? "- Explicitly mention identity uncertainty in Missing Evidence."
        : "- Never describe the symbol as a placeholder or unknown identifier.",
    ].join("\n");
  }

  /**
   * Renders compact memory lines for R# references.
   */
  formatMemoryLines(matches: EmbeddingMemoryMatch[]): string {
    if (matches.length === 0) {
      return "- none";
    }

    return matches
      .map((match, index) => {
        const snippet = match.content.replace(/\s+/g, " ").trim().slice(0, 220);
        return `- R${index + 1} run=${match.runId ?? "unknown"} similarity=${match.similarity.toFixed(3)} created=${match.createdAt.toISOString().slice(0, 10)}: ${snippet}`;
      })
      .join("\n");
  }

  /**
   * Builds deterministic evidence map lines for post-processing.
   */
  buildEvidenceMapLines(
    docs: DocumentEntity[],
    newsLabelByDocumentId: Map<string, string>,
    metrics: MetricPointEntity[],
    filings: FilingEntity[],
    memoryMatches: EmbeddingMemoryMatch[],
  ): string {
    const lines: string[] = [];

    docs.slice(0, 10).forEach((doc) => {
      const label = newsLabelByDocumentId.get(doc.id);
      if (!label) {
        return;
      }
      lines.push(`- ${label}: news "${doc.title}"`);
    });
    metrics.slice(0, 12).forEach((metric, index) => {
      lines.push(
        `- M${index + 1}: metric ${metric.metricName}=${this.formatMetricValue(metric)}${metric.metricUnit ? ` ${metric.metricUnit}` : ""}`,
      );
    });
    filings.slice(0, 6).forEach((filing, index) => {
      lines.push(
        `- F${index + 1}: filing ${filing.filingType} ${filing.filedAt.toISOString().slice(0, 10)}`,
      );
    });
    memoryMatches.slice(0, 6).forEach((match, index) => {
      lines.push(
        `- R${index + 1}: prior-run memory similarity=${match.similarity.toFixed(3)} date=${match.createdAt.toISOString().slice(0, 10)}`,
      );
    });

    return lines.length > 0 ? lines.join("\n") : "- none";
  }

  /**
   * Builds one-shot repair prompt from validation failures.
   */
  buildRepairPrompt(
    basePrompt: string,
    draftThesis: string,
    issues: string[],
  ): string {
    return [
      "Repair this thesis draft by fixing all validation failures.",
      "Keep the same required headings and only use provided evidence.",
      "Remove internal pipeline jargon from investor-facing sections.",
      "No placeholder guidance language (watch for/monitor/could/may).",
      "",
      "Validation failures:",
      ...issues.map((issue) => `- ${issue}`),
      "",
      "Original synthesis prompt:",
      basePrompt,
      "",
      "Current thesis draft:",
      draftThesis,
    ].join("\n");
  }
}
