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
   * Builds the synthesis prompt contract for first-pass generation.
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
    actionMatrixLines: string;
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
      "Do not leave Conclusion uncited.",
      "Avoid repeating the same uncertainty sentence across sections.",
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
      "News relevance diagnostics:",
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
      "Deterministic action matrix seed (must be preserved in If/Then triggers):",
      args.actionMatrixLines,
      "",
      "Deterministic decision seed:",
      `- decision=${args.decisionFromContext}`,
      args.decisionReasonLines,
      "",
      "Output requirements:",
      "- Return Markdown with headings in this order: Action Summary, Overview, Shareholder/Institutional Dynamics, Valuation and Growth Interpretation, Regulatory Filings, Missing Evidence, Conclusion.",
      "- Under # Action Summary, include exactly these labeled bullets:",
      "  - Decision: Buy|Watch|Avoid|Watch (Low Quality)|Insufficient Evidence",
      "  - Timeframe fit: Short-term (0-3m) ... ; Long-term (12m+) ...",
      "  - Reasons to invest:",
      "  - Reasons to stay away:",
      "  - If/Then triggers:",
      "  - Thesis invalidation:",
      "- Under Reasons to invest and Reasons to stay away, add 2-3 supporting sub-bullets each with citations.",
      "- Under If/Then triggers, add 3-5 sub-bullets in 'If ... then ...' form using numeric thresholds or filing booleans only.",
      "- Under Thesis invalidation, add 2-3 sub-bullets describing clear thesis break conditions.",
      "- Decision and each If/Then trigger must include at least one citation when evidence exists.",
      "- Do not include uncited claims in any section when evidence labels are available.",
      "- Decision should default to deterministic seed decision unless evidence in this run clearly contradicts it.",
      "- Avoid generic trigger language such as 'watch for', 'monitor', 'could', or 'may'.",
      "- If evidenceWeak=true, default Decision to Watch unless evidence strongly contradicts that default.",
      "- Use R# memory references only as supporting context, not as sole support for directional decisions when current-run evidence exists.",
      "- If memory conflicts with current-run evidence, explicitly call out the conflict in Missing Evidence.",
      "- For each section, tie claims to one or more evidence items (N_<class>#, M#, F# labels).",
      "- Explain what changed in shareholder/institutional dynamics.",
      "- Connect valuation or growth interpretation to provided metrics when available.",
      "- Use filings to support or challenge narrative when available.",
      "- Keep Overview/Valuation/Regulatory/Missing Evidence/Conclusion consistent with Action Summary.",
      "- In Conclusion, reaffirm Decision or explicitly explain any downgrade caused by evidence gaps.",
      "- Use only deterministic matrix trigger concepts for If/Then; do not invent new trigger families.",
      "- When a signal is missing, explicitly say which metric/fact is missing.",
      "- Explicitly state missing evidence if a section is empty.",
      "- If metrics diagnostics indicate missing or degraded metrics, mention that limitation in Missing Evidence.",
      "- If provider failures or pipeline stage issues are present, call them out explicitly in Missing Evidence.",
      "- If lowRelevance=true, explicitly state that weak issuer-specific headline relevance limits confidence.",
      "- If excludedHeadlines is high versus issuerMatchedHeadlines, explicitly mention noise pressure in Missing Evidence.",
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
      "Replace generic trigger phrasing with threshold/action trigger phrasing.",
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
