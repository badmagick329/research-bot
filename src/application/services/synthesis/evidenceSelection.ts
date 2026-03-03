import type {
  DocumentEntity,
  NewsEvidenceClass,
} from "../../../core/entities/document";
import type {
  HorizonBucket,
  ResolvedCompanyIdentity,
} from "../../../core/entities/research";
import {
  type NewsDocumentClass,
  type NewsScoredItem,
  scoreNewsCandidate,
} from "../newsScoringV2";
import type {
  ExcludedHeadlineReason,
  IssuerIdentityPatterns,
  IssuerMatchField,
  IssuerMatchResult,
  RelevanceMode,
  RelevanceSelection,
  SynthesisEvidenceSelectorPort,
} from "./types";

const evidenceClassSortOrder: Record<NewsEvidenceClass, number> = {
  issuer: 0,
  peer: 1,
  supply_chain: 2,
  customer: 3,
  industry: 4,
};

/**
 * Implements deterministic issuer-matching and evidence selection for synthesis.
 */
export class DeterministicSynthesisEvidenceSelector
  implements SynthesisEvidenceSelectorPort
{
  private readonly payloadOnlyRecoveryRatioThreshold = 0.8;

  constructor(
    private readonly relevanceMode: RelevanceMode,
    private readonly issuerMatchMinFields: number,
    private readonly newsV2MinCompositeScore: number,
    private readonly newsV2MinMaterialityScore: number,
    private readonly newsV2MinKpiLinkageScore: number,
    private readonly newsV2MaxItems: number,
    private readonly newsV2SourceQualityMode: "default",
  ) {}

  /**
   * Selects issuer-relevant evidence candidates and produces diagnostics for synthesis/persistence.
   */
  selectRelevantDocuments(args: {
    docs: DocumentEntity[];
    symbol: string;
    identity: ResolvedCompanyIdentity | undefined;
    horizon: HorizonBucket;
    selectedKpiNames: string[];
  }): RelevanceSelection {
    const emptyPrefilterClassCounts: Record<NewsDocumentClass, number> = {
      issuer_news: 0,
      read_through_news: 0,
      market_context: 0,
      generic_market_noise: 0,
    };

    if (args.docs.length === 0) {
      return {
        selected: [],
        classifiedDocuments: [],
        selectedNewsLabels: [],
        newsLabelByDocumentId: new Map<string, string>(),
        issuerAnchorPresent: false,
        includedByClass: {
          issuer: 0,
          peer: 0,
          supply_chain: 0,
          customer: 0,
          industry: 0,
        },
        excludedByClass: {
          issuer: 0,
          peer: 0,
          supply_chain: 0,
          customer: 0,
          industry: 0,
        },
        excludedByClassAndReason: {},
        relevantHeadlinesCount: 0,
        selectedRelevantCount: 0,
        lowRelevance: true,
        totalHeadlinesCount: 0,
        issuerMatchedHeadlinesCount: 0,
        excludedHeadlinesCount: 0,
        excludedHeadlineReasons: [],
        excludedHeadlineReasonSamples: [],
        averageCompositeScore: 0,
        excludedByReason: {},
        issuerAnchorCount: 0,
        prefilterClassCountsBefore: { ...emptyPrefilterClassCounts },
        prefilterClassCountsAfter: { ...emptyPrefilterClassCounts },
        issuerAnchorAvailable: false,
        issuerAnchorAvailableCount: 0,
        issuerMatchDiagnostics: {
          title: 0,
          summary: 0,
          content: 0,
          payload: 0,
          payloadOnlyRejected: 0,
        },
        payloadOnlyRecovery: {
          payloadOnlyRatio: 0,
          recoveryInvoked: false,
          recoveryStatus: "not_needed",
          recoveryReason: "no_documents",
          issuerAnchorAvailableBefore: false,
          issuerAnchorAvailableAfter: false,
          issuerAnchorSelectedBefore: 0,
          issuerAnchorSelectedAfter: 0,
          metricHeavyDueToNarrativeGap: false,
        },
        scoreBreakdownSample: [],
      };
    }

    const identityPatterns = this.buildIssuerIdentityPatterns(
      args.symbol,
      args.identity,
    );
    const baseline = this.evaluateRelevanceSelection({
      docs: args.docs,
      identityPatterns,
      horizon: args.horizon,
      selectedKpiNames: args.selectedKpiNames,
    });
    const payloadOnlyRatio =
      args.docs.length === 0
        ? 0
        : Number.parseFloat(
            (
              baseline.issuerMatchDiagnostics.payloadOnlyRejected /
              Math.max(1, args.docs.length)
            ).toFixed(4),
          );
    const shouldAttemptRecovery =
      payloadOnlyRatio >= this.payloadOnlyRecoveryRatioThreshold &&
      baseline.issuerAnchorCount === 0;

    const recoveryTokens = shouldAttemptRecovery
      ? this.buildCompanyRecoveryTokens(args.identity)
      : new Set<string>();
    const recovered =
      shouldAttemptRecovery && recoveryTokens.size > 0
        ? this.evaluateRelevanceSelection({
            docs: args.docs,
            identityPatterns,
            horizon: args.horizon,
            selectedKpiNames: args.selectedKpiNames,
            recoveryCompanyTokens: recoveryTokens,
          })
        : undefined;
    const recoveredIssuerAnchorCount = recovered?.issuerAnchorCount ?? 0;
    const useRecovered =
      Boolean(recovered) && recoveredIssuerAnchorCount > baseline.issuerAnchorCount;
    const selected = useRecovered && recovered ? recovered : baseline;
    const recoveryStatus = !shouldAttemptRecovery
      ? "not_needed"
      : useRecovered
        ? "recovered"
        : "not_recovered";
    const recoveryReason = !shouldAttemptRecovery
      ? "payload_only_ratio_below_threshold_or_issuer_anchor_present"
      : recoveryTokens.size === 0
        ? "missing_company_tokens"
        : useRecovered
          ? "issuer_anchor_recovered"
          : "issuer_anchor_not_recovered";

    return {
      ...selected,
      payloadOnlyRecovery: {
        payloadOnlyRatio,
        recoveryInvoked: shouldAttemptRecovery,
        recoveryStatus,
        recoveryReason,
        issuerAnchorAvailableBefore: baseline.issuerAnchorAvailable,
        issuerAnchorAvailableAfter: selected.issuerAnchorAvailable,
        issuerAnchorSelectedBefore: baseline.issuerAnchorCount,
        issuerAnchorSelectedAfter: selected.issuerAnchorCount,
        metricHeavyDueToNarrativeGap:
          selected.issuerAnchorCount === 0 && selected.selected.length === 0,
      },
    };
  }

  /**
   * Executes one deterministic relevance pass so baseline and recovery runs share identical ranking logic.
   */
  private evaluateRelevanceSelection(args: {
    docs: DocumentEntity[];
    identityPatterns: IssuerIdentityPatterns;
    horizon: HorizonBucket;
    selectedKpiNames: string[];
    recoveryCompanyTokens?: Set<string>;
  }): Omit<RelevanceSelection, "payloadOnlyRecovery"> {
    const excludedHeadlineReasons: ExcludedHeadlineReason[] = [];
    const excludedHeadlineReasonSamples: string[] = [];
    const excludedByReason: Record<string, number> = {};
    const excludedByClass: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const includedByClass: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const excludedByClassAndReason: Record<string, Record<string, number>> = {};
    const prefilterClassCountsBefore: Record<NewsDocumentClass, number> = {
      issuer_news: 0,
      read_through_news: 0,
      market_context: 0,
      generic_market_noise: 0,
    };
    const prefilterClassCountsAfter: Record<NewsDocumentClass, number> = {
      issuer_news: 0,
      read_through_news: 0,
      market_context: 0,
      generic_market_noise: 0,
    };
    const issuerMatchDiagnostics = {
      title: 0,
      summary: 0,
      content: 0,
      payload: 0,
      payloadOnlyRejected: 0,
    };
    const seenTitle = new Set<string>();
    const seenUrl = new Set<string>();
    const scored: NewsScoredItem[] = [];
    args.docs.forEach((doc) => {
      const match = this.matchesIssuerIdentity(
        doc,
        args.identityPatterns,
        args.recoveryCompanyTokens,
      );
      if (match.matchedFields.includes("title")) {
        issuerMatchDiagnostics.title += 1;
      }
      if (match.matchedFields.includes("summary")) {
        issuerMatchDiagnostics.summary += 1;
      }
      if (match.matchedFields.includes("content")) {
        issuerMatchDiagnostics.content += 1;
      }
      if (match.matchedFields.includes("payload")) {
        issuerMatchDiagnostics.payload += 1;
      }
      if (match.payloadOnlyMatch) {
        issuerMatchDiagnostics.payloadOnlyRejected += 1;
      }
      const scoredItem = scoreNewsCandidate(
        {
          doc,
          issuerMatched: match.matched,
          payloadOnlyIssuerMatch: match.payloadOnlyMatch,
          horizon: args.horizon,
          kpiNames: args.selectedKpiNames,
          seenTitleKeys: seenTitle,
          seenUrlKeys: seenUrl,
          sourceQualityMode: this.newsV2SourceQualityMode,
        },
        {
          minCompositeScore: this.newsV2MinCompositeScore,
          minMaterialityScore: this.newsV2MinMaterialityScore,
          minKpiLinkageScore: this.newsV2MinKpiLinkageScore,
          sourceQualityMode: this.newsV2SourceQualityMode,
        },
      );
      scored.push(scoredItem);
      prefilterClassCountsBefore[scoredItem.documentClass] += 1;
      if (scoredItem.urlKey) {
        seenUrl.add(scoredItem.urlKey);
      }
      if (scoredItem.titleKey) {
        seenTitle.add(scoredItem.titleKey);
      }
    });

    const rankingEligible = scored.filter((item) => item.includedByThresholds);
    rankingEligible.forEach((item) => {
      prefilterClassCountsAfter[item.documentClass] += 1;
    });
    const issuerAnchorCandidates = rankingEligible.filter(
      (item) => item.evidenceClass === "issuer",
    );
    const issuerAnchorAvailable = issuerAnchorCandidates.length > 0;
    const maxNonIssuerItems = Math.floor(this.newsV2MaxItems * 0.4);
    let selectedNonIssuerCount = 0;
    const sortedCandidates = [...scored].sort((left, right) => {
      if (right.composite !== left.composite) {
        return right.composite - left.composite;
      }
      const classOrderDelta =
        evidenceClassSortOrder[left.evidenceClass] -
        evidenceClassSortOrder[right.evidenceClass];
      if (classOrderDelta !== 0) {
        return classOrderDelta;
      }
      return right.doc.publishedAt.getTime() - left.doc.publishedAt.getTime();
    });

    const evaluatedCandidates = sortedCandidates.map((item) => ({
      ...item,
      includedFinal: false,
      exclusionReason: item.exclusionReason as ExcludedHeadlineReason | undefined,
    }));
    const evaluatedById = new Map(
      evaluatedCandidates.map((item) => [item.doc.id, item]),
    );
    const selectedDocumentIds = new Set<string>();
    const excludedDocumentIds = new Set<string>();
    const selectedProviders = new Set<string>();

    const applySelection = (item: NewsScoredItem) => {
      if (selectedDocumentIds.has(item.doc.id)) {
        return;
      }
      const evaluated = evaluatedById.get(item.doc.id);
      if (!evaluated) {
        return;
      }
      evaluated.includedFinal = true;
      evaluated.exclusionReason = undefined;
      selectedDocumentIds.add(item.doc.id);
      selectedProviders.add(item.doc.provider.toLowerCase());
      includedByClass[item.evidenceClass] += 1;
      if (item.evidenceClass !== "issuer") {
        selectedNonIssuerCount += 1;
      }
    };

    const applyExclusion = (
      item: NewsScoredItem,
      reason: ExcludedHeadlineReason,
    ) => {
      const evaluated = evaluatedById.get(item.doc.id);
      if (!evaluated || evaluated.includedFinal) {
        return;
      }
      evaluated.exclusionReason = reason;
      excludedDocumentIds.add(item.doc.id);
    };

    if (issuerAnchorAvailable) {
      const bestIssuerAnchor = sortedCandidates.find(
        (item) => item.includedByThresholds && item.evidenceClass === "issuer",
      );
      if (bestIssuerAnchor) {
        applySelection(bestIssuerAnchor);
      }
    }

    while (selectedDocumentIds.size < this.newsV2MaxItems) {
      const remaining = sortedCandidates.filter(
        (item) =>
          !selectedDocumentIds.has(item.doc.id) &&
          !excludedDocumentIds.has(item.doc.id),
      );
      if (remaining.length === 0) {
        break;
      }

      const rankedRemaining = remaining
        .map((item) => {
          let adjustedScore = item.composite;
          const providerKey = item.doc.provider.toLowerCase();
          if (!selectedProviders.has(providerKey)) {
            adjustedScore += 4;
          }
          if (includedByClass[item.evidenceClass] === 0) {
            adjustedScore += 3;
          }
          if (item.evidenceClass === "issuer" && includedByClass.issuer === 0) {
            adjustedScore += 8;
          }
          return { item, adjustedScore };
        })
        .sort((left, right) => {
          if (right.adjustedScore !== left.adjustedScore) {
            return right.adjustedScore - left.adjustedScore;
          }
          return (
            right.item.doc.publishedAt.getTime() - left.item.doc.publishedAt.getTime()
          );
        });
      const next = rankedRemaining.at(0)?.item;
      if (!next) {
        break;
      }

      if (!next.includedByThresholds) {
        applyExclusion(
          next,
          (next.exclusionReason ??
            "below_composite_threshold") as ExcludedHeadlineReason,
        );
        continue;
      }

      const isReadThrough = next.evidenceClass !== "issuer";
      if (isReadThrough && !issuerAnchorAvailable) {
        applyExclusion(next, "read_through_without_issuer_anchor");
        continue;
      }
      if (isReadThrough && includedByClass.issuer === 0) {
        applyExclusion(next, "read_through_without_issuer_anchor");
        continue;
      }
      if (isReadThrough && selectedNonIssuerCount >= maxNonIssuerItems) {
        applyExclusion(next, "read_through_capped");
        continue;
      }

      applySelection(next);
    }

    evaluatedCandidates
      .filter((item) => !item.includedFinal && !item.exclusionReason)
      .forEach((item) => {
        item.exclusionReason = "below_composite_threshold";
      });

    const selectedRanked = evaluatedCandidates.filter((item) => item.includedFinal);
    selectedRanked.forEach((item) => {
      const nextDoc = item.doc;
      nextDoc.evidenceClass = item.evidenceClass;
    });

    const classCounters: Record<NewsEvidenceClass, number> = {
      issuer: 0,
      peer: 0,
      supply_chain: 0,
      customer: 0,
      industry: 0,
    };
    const newsLabelByDocumentId = new Map<string, string>();
    selectedRanked.forEach((item) => {
      classCounters[item.evidenceClass] += 1;
      newsLabelByDocumentId.set(
        item.doc.id,
        `N_${item.evidenceClass}${classCounters[item.evidenceClass]}`,
      );
    });

    evaluatedCandidates
      .filter((item) => !item.includedFinal)
      .forEach((item) => {
        const reason = item.exclusionReason ?? "below_composite_threshold";
        excludedHeadlineReasons.push(reason);
        excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
        excludedByClass[item.evidenceClass] += 1;
        if (!excludedByClassAndReason[item.evidenceClass]) {
          excludedByClassAndReason[item.evidenceClass] = {};
        }
        const classReasonCounts = excludedByClassAndReason[item.evidenceClass];
        if (!classReasonCounts) {
          return;
        }
        classReasonCounts[reason] = (classReasonCounts[reason] ?? 0) + 1;
        if (excludedHeadlineReasonSamples.length < 8) {
          excludedHeadlineReasonSamples.push(
            `${item.doc.title.slice(0, 96)} (${item.evidenceClass}; ${reason}; composite=${item.composite})`,
          );
        }
      });

    const selectedRelevantCount = selectedRanked.length;
    const lowRelevance =
      selectedRanked.length === 0 ||
      selectedRelevantCount < 3 ||
      selectedRelevantCount / Math.max(1, selectedRanked.length) < 0.5;
    const averageCompositeScore =
      evaluatedCandidates.length === 0
        ? 0
        : Number.parseFloat(
            (
              evaluatedCandidates.reduce((sum, item) => sum + item.composite, 0) /
              evaluatedCandidates.length
            ).toFixed(2),
          );
    const scoreBreakdownSample = evaluatedCandidates.slice(0, 8).map((item) => ({
      title: item.doc.title,
      composite: item.composite,
      components: item.components,
      included: item.includedFinal,
      reason: item.includedFinal ? undefined : item.exclusionReason,
      documentClass: item.documentClass,
      confidenceBand: item.confidenceBand,
    }));

    return {
      selected: selectedRanked.map((item) => ({
        ...item.doc,
        evidenceClass: item.evidenceClass,
      })),
      classifiedDocuments: evaluatedCandidates.map((item) => ({
        ...item.doc,
        evidenceClass: item.evidenceClass,
      })),
      selectedNewsLabels: selectedRanked
        .map((item) => newsLabelByDocumentId.get(item.doc.id))
        .filter((label): label is string => Boolean(label)),
      newsLabelByDocumentId,
      issuerAnchorPresent: includedByClass.issuer > 0,
      includedByClass,
      excludedByClass,
      excludedByClassAndReason,
      relevantHeadlinesCount: selectedRanked.length,
      selectedRelevantCount,
      lowRelevance,
      totalHeadlinesCount: args.docs.length,
      issuerMatchedHeadlinesCount: scored.filter(
        (item) => item.evidenceClass === "issuer",
      ).length,
      excludedHeadlinesCount: args.docs.length - selectedRanked.length,
      excludedHeadlineReasons,
      excludedHeadlineReasonSamples,
      averageCompositeScore,
      excludedByReason,
      issuerAnchorCount: includedByClass.issuer,
      prefilterClassCountsBefore,
      prefilterClassCountsAfter,
      issuerAnchorAvailable,
      issuerAnchorAvailableCount: issuerAnchorCandidates.length,
      issuerMatchDiagnostics,
      scoreBreakdownSample,
    };
  }

  /**
   * Builds strict recovery tokens from company name words so payload-only spikes can retry narrative matching without using payload hints.
   */
  private buildCompanyRecoveryTokens(
    identity: ResolvedCompanyIdentity | undefined,
  ): Set<string> {
    if (!identity) {
      return new Set<string>();
    }
    const ignored = new Set([
      "inc",
      "incorporated",
      "corp",
      "corporation",
      "co",
      "company",
      "ltd",
      "limited",
      "plc",
      "holdings",
      "group",
      "class",
      "common",
      "com",
    ]);
    return new Set(
      identity.companyName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !ignored.has(token)),
    );
  }

  /**
   * Decides whether synthesis must force identity uncertainty messaging based on resolution confidence and evidence quality.
   */
  shouldForceIdentityUncertainty(
    identity: ResolvedCompanyIdentity | undefined,
    selection: RelevanceSelection,
  ): boolean {
    if (!identity) {
      return true;
    }

    if (identity.resolutionSource === "manual_map") {
      return false;
    }

    if (identity.confidence >= 0.6) {
      return false;
    }

    return selection.selectedRelevantCount === 0;
  }

  /**
   * Extracts lowercase ticker-related strings from provider payloads to help relevance ranking.
   */
  private extractPayloadTickerHints(rawPayload: unknown): string[] {
    if (!rawPayload || typeof rawPayload !== "object") {
      return [];
    }

    const payload = rawPayload as Record<string, unknown>;
    const hints: string[] = [];

    const related = payload.related;
    if (typeof related === "string") {
      hints.push(
        ...related
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      );
    }

    const tickerSentiment = payload.ticker_sentiment;
    if (Array.isArray(tickerSentiment)) {
      tickerSentiment.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
          return;
        }

        const ticker = (entry as Record<string, unknown>).ticker;
        if (typeof ticker === "string" && ticker.trim().length > 0) {
          hints.push(ticker.trim().toLowerCase());
        }
      });
    }

    const symbols = payload.symbols;
    if (Array.isArray(symbols)) {
      symbols.forEach((value) => {
        if (typeof value === "string" && value.trim().length > 0) {
          hints.push(value.trim().toLowerCase());
        }
      });
    }

    return hints;
  }

  /**
   * Builds normalized issuer identity patterns so symbol/name/alias matching can gate headline inclusion deterministically.
   */
  private buildIssuerIdentityPatterns(
    symbol: string,
    identity: ResolvedCompanyIdentity | undefined,
  ): IssuerIdentityPatterns {
    const symbolExactTokens = new Set<string>();
    const symbolPhraseTokens = new Set<string>();
    const aliasExactTokens = new Set<string>();
    const aliasPhraseTokens = new Set<string>();
    const companyExactTokens = new Set<string>();
    const companyPhraseTokens = new Set<string>();
    const exactTokens = new Set<string>();
    const phraseTokens = new Set<string>();

    const addToken = (
      raw: string,
      exactBucket: Set<string>,
      phraseBucket: Set<string>,
    ) => {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) {
        return;
      }

      const punctuationStripped = normalized
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const noSuffix = punctuationStripped
        .replace(
          /\b(inc|incorporated|corp|corporation|co|company|plc|ltd|limited)\b/g,
          "",
        )
        .replace(/\s+/g, " ")
        .trim();

      [normalized, punctuationStripped, noSuffix].forEach((candidate) => {
        if (!candidate) {
          return;
        }
        if (/^[a-z0-9]{2,5}$/.test(candidate)) {
          exactTokens.add(candidate);
          exactBucket.add(candidate);
        } else {
          phraseTokens.add(candidate);
          phraseBucket.add(candidate);
        }
      });
    };

    addToken(symbol, symbolExactTokens, symbolPhraseTokens);
    if (identity) {
      addToken(identity.canonicalSymbol, symbolExactTokens, symbolPhraseTokens);
      addToken(identity.requestedSymbol, symbolExactTokens, symbolPhraseTokens);
      identity.aliases.forEach((alias) =>
        addToken(alias, aliasExactTokens, aliasPhraseTokens),
      );
      addToken(identity.companyName, companyExactTokens, companyPhraseTokens);
    }

    return {
      symbolExactTokens,
      symbolPhraseTokens,
      aliasExactTokens,
      aliasPhraseTokens,
      companyExactTokens,
      companyPhraseTokens,
      exactTokens,
      phraseTokens,
    };
  }

  /**
   * Enforces issuer identity gating so non-issuer headlines are excluded before relevance ranking.
   */
  private matchesIssuerIdentity(
    doc: DocumentEntity,
    patterns: IssuerIdentityPatterns,
    recoveryCompanyTokens?: Set<string>,
  ): IssuerMatchResult {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const fields: Record<IssuerMatchField, string> = {
      title: normalize(doc.title),
      summary: normalize(doc.summary ?? ""),
      content: normalize(doc.content),
      payload: normalize(this.extractPayloadTickerHints(doc.rawPayload).join(" ")),
      alias: "",
      company: "",
    };

    const matchesTokenGroup = (
      fieldValue: string,
      exactGroup: Set<string>,
      phraseGroup: Set<string>,
    ): boolean => {
      if (!fieldValue) {
        return false;
      }

      for (const token of exactGroup) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(fieldValue)) {
          return true;
        }
      }

      for (const phrase of phraseGroup) {
        if (fieldValue.includes(phrase)) {
          return true;
        }
      }

      return false;
    };
    const matchesRecoveryCompanyTokens = (
      fieldValue: string,
      tokens: Set<string>,
    ): boolean => {
      if (!fieldValue || tokens.size === 0) {
        return false;
      }
      for (const token of tokens) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(fieldValue)) {
          return true;
        }
      }
      return false;
    };

    const matchedFields = new Set<IssuerMatchField>();
    const narrativeRecoveryTokens = recoveryCompanyTokens ?? new Set<string>();
    let titleMatched = false;
    let summaryMatched = false;
    let contentMatched = false;
    let payloadMatched = false;
    (Object.entries(fields) as Array<[IssuerMatchField, string]>)
      .filter(
        ([field]) =>
          field === "title" ||
          field === "summary" ||
          field === "content" ||
          field === "payload",
      )
      .forEach(([field, fieldValue]) => {
        const tokenMatch = matchesTokenGroup(
          fieldValue,
          patterns.exactTokens,
          patterns.phraseTokens,
        );
        const aliasMatch = matchesTokenGroup(
          fieldValue,
          patterns.aliasExactTokens,
          patterns.aliasPhraseTokens,
        );
        const companyMatch = matchesTokenGroup(
          fieldValue,
          patterns.companyExactTokens,
          patterns.companyPhraseTokens,
        );
        const recoveryTokenMatch =
          field !== "payload" &&
          matchesRecoveryCompanyTokens(fieldValue, narrativeRecoveryTokens);
        if (tokenMatch || aliasMatch || companyMatch || recoveryTokenMatch) {
          matchedFields.add(field);
          if (field === "title") {
            titleMatched = true;
          } else if (field === "summary") {
            summaryMatched = true;
          } else if (field === "content") {
            contentMatched = true;
          } else if (field === "payload") {
            payloadMatched = true;
          }
        }
        if (aliasMatch) {
          matchedFields.add("alias");
        }
        if (companyMatch) {
          matchedFields.add("company");
        }
        if (recoveryTokenMatch) {
          matchedFields.add("company");
        }
      });
    const matchedFieldsList = Array.from(matchedFields);
    const fieldsMatched = matchedFieldsList.length;
    const narrativeMatch = titleMatched || summaryMatched || contentMatched;
    const payloadOnlyMatch = payloadMatched && !narrativeMatch;
    if (payloadOnlyMatch) {
      return {
        matched: false,
        fieldsMatched,
        matchedFields: matchedFieldsList,
        payloadOnlyMatch: true,
        reason: "payload_only_issuer_match",
      };
    }
    if (fieldsMatched >= this.issuerMatchMinFields && narrativeMatch) {
      return {
        matched: true,
        fieldsMatched,
        matchedFields: matchedFieldsList,
        payloadOnlyMatch: false,
      };
    }

    return {
      matched: false,
      fieldsMatched,
      matchedFields: matchedFieldsList,
      payloadOnlyMatch: false,
      reason: "no_issuer_identity_match",
    };
  }
}
