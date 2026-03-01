import type {
  DocumentEntity,
  NewsEvidenceClass,
} from "../../core/entities/document";
import type { HorizonBucket } from "../../core/entities/research";

export type NewsV2ExclusionReason =
  | "no_issuer_identity_match"
  | "payload_only_issuer_match"
  | "duplicate_title"
  | "duplicate_url"
  | "market_context_prefiltered"
  | "generic_market_noise_prefiltered"
  | "explicit_market_noise_pattern"
  | "issuer_noise_or_adjacent_context"
  | "below_materiality_threshold"
  | "below_kpi_linkage_threshold"
  | "below_composite_threshold"
  | "low_source_quality"
  | "stale_for_horizon"
  | "read_through_without_issuer_anchor";

export type NewsDocumentClass =
  | "issuer_news"
  | "read_through_news"
  | "market_context"
  | "generic_market_noise";

export type NewsScoreConfidenceBand = "high" | "medium" | "low";

export type NewsScoreComponents = {
  issuerMatchScore: number;
  economicMaterialityScore: number;
  noveltyScore: number;
  horizonRelevanceScore: number;
  kpiLinkageScore: number;
  sourceQualityScore: number;
};

export type NewsScoredItem = {
  doc: DocumentEntity;
  evidenceClass: NewsEvidenceClass;
  documentClass: NewsDocumentClass;
  components: NewsScoreComponents;
  composite: number;
  confidenceBand: NewsScoreConfidenceBand;
  includedByThresholds: boolean;
  exclusionReason?: NewsV2ExclusionReason;
  debugReason?: string;
  titleKey: string;
  urlKey: string;
};

export type NewsScoringConfig = {
  minCompositeScore: number;
  minMaterialityScore: number;
  minKpiLinkageScore: number;
  sourceQualityMode: "default";
};

export type NewsScoringInput = {
  doc: DocumentEntity;
  issuerMatched: boolean;
  payloadOnlyIssuerMatch?: boolean;
  horizon: HorizonBucket;
  kpiNames: string[];
  seenTitleKeys: Set<string>;
  seenUrlKeys: Set<string>;
  sourceQualityMode: "default";
};

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const canonicalizeUrl = (value: string | undefined): string => {
  if (!value || !value.trim()) {
    return "";
  }
  try {
    const parsed = new URL(value.trim());
    parsed.hash = "";
    const keptParams = new URLSearchParams();
    parsed.searchParams.forEach((paramValue, key) => {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower === "fbclid" ||
        lower === "gclid" ||
        lower === "mc_cid" ||
        lower === "mc_eid"
      ) {
        return;
      }
      keptParams.append(key, paramValue);
    });
    parsed.search = keptParams.toString();
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${pathname}${parsed.search ? `?${parsed.search}` : ""}`;
  } catch {
    return value.trim().toLowerCase();
  }
};

/**
 * Classifies headline evidence class deterministically so downstream policy can enforce issuer-anchored read-through handling.
 */
export const classifyEvidenceClass = (
  text: string,
  issuerMatched: boolean,
): NewsEvidenceClass => {
  if (issuerMatched) {
    return "issuer";
  }
  if (/\b(peer|competitor|rival|peer group)\b/.test(text)) {
    return "peer";
  }
  if (/\b(supplier|foundry|component|channel|shipment|inventory)\b/.test(text)) {
    return "supply_chain";
  }
  if (/\b(customer|enterprise|buyer|order book|contract win)\b/.test(text)) {
    return "customer";
  }
  return "industry";
};

const scoreEconomicMateriality = (text: string): number => {
  let score = 50;
  const materialSignals = [
    "guidance",
    "margin",
    "demand",
    "growth",
    "momentum",
    "litigation",
    "regulatory",
    "approval",
    "backlog",
    "earnings",
    "contract",
    "launch",
    "capacity",
    "expands",
    "expansion",
    "capex",
    "buyback",
  ];
  const noisySignals = [
    "shares rose",
    "shares fell",
    "stock rose",
    "stock fell",
    "market wrap",
    "daily movers",
    "premarket",
    "etf",
    "top stocks",
    "stocks to buy",
  ];

  materialSignals.forEach((signal) => {
    if (text.includes(signal)) {
      score += 6;
    }
  });
  noisySignals.forEach((signal) => {
    if (text.includes(signal)) {
      score -= 15;
    }
  });

  return clampScore(score);
};

/**
 * Assigns a deterministic document class so context artifacts can be filtered out before ranking.
 */
export const classifyNewsDocumentClass = (
  text: string,
  evidenceClass: NewsEvidenceClass,
): NewsDocumentClass => {
  const marketContextPatterns = [
    /\bmarket wrap\b/,
    /\bstock market today\b/,
    /\bdaily movers\b/,
    /\bequity futures\b/,
    /\bindex futures\b/,
    /\bpre[-\s]?market\b/,
    /\bwall street\b/,
    /\bdow\b/,
    /\bs&p\b/,
    /\bnasdaq\b/,
    /\btreasury yields?\b/,
    /\bbroad market\b/,
  ];
  if (marketContextPatterns.some((pattern) => pattern.test(text))) {
    return "market_context";
  }

  const genericNoisePatterns = [
    /\bstocks to buy\b/,
    /\btop stocks\b/,
    /\bbest stocks\b/,
    /\bwatchlist\b/,
    /\bwhich stock is a better buy\b/,
    /\bhot stocks\b/,
    /\btop picks\b/,
    /\betf picks\b/,
  ];
  if (genericNoisePatterns.some((pattern) => pattern.test(text))) {
    return "generic_market_noise";
  }

  return evidenceClass === "issuer" ? "issuer_news" : "read_through_news";
};

/**
 * Detects explicit broad-market/listicle framing that must always be hard-excluded.
 */
const hasExplicitMarketNoisePattern = (text: string): boolean => {
  const hardPatterns = [
    /\bmarket wrap\b/,
    /\bdaily movers\b/,
    /\bstocks to buy\b/,
    /\btop stocks\b/,
    /\bstock market today\b/,
    /\blive coverage\b/,
    /\bexchange traded funds?\b/,
    /\bequity futures\b/,
    /\bpre bell\b/,
    /\bpre bell\b/,
    /\bpremarket\b/,
    /\bwhich stock is a better buy\b/,
  ];

  return hardPatterns.some((pattern) => pattern.test(text));
};

/**
 * Detects adjacent framing that should reduce ranking score without forcing hard exclusion.
 */
const hasAdjacentNoiseSignal = (text: string): boolean =>
  /\bshares rose\b|\bshares fell\b|\bstock rose\b|\bstock fell\b|\blive coverage\b|\bmarket chatter\b/.test(
    text,
  );

/**
 * Buckets confidence so ranking diagnostics can explain why borderline headlines were selected or dropped.
 */
const toConfidenceBand = (
  composite: number,
  penaltyPoints: number,
): NewsScoreConfidenceBand => {
  if (composite >= 80 && penaltyPoints <= 8) {
    return "high";
  }
  if (composite >= 65) {
    return "medium";
  }
  return "low";
};

const scoreHorizonRelevance = (text: string, horizon: HorizonBucket): number => {
  const nearTermSignals = /(next earnings|approval|litigation|launch|guidance update|this quarter)/;
  const mediumTermSignals = /(inventory normalization|margin inflection|estimate revision|next two quarters)/;
  const longTermSignals = /(moat|reinvestment|runway|multi year|capital allocation|structural)/;

  if (horizon === "0_4_weeks") {
    return nearTermSignals.test(text) ? 85 : 45;
  }
  if (horizon === "1_2_quarters") {
    return mediumTermSignals.test(text) || nearTermSignals.test(text) ? 80 : 50;
  }
  return longTermSignals.test(text) ? 85 : 52;
};

const scoreKpiLinkage = (text: string, kpiNames: string[]): number => {
  if (kpiNames.length === 0) {
    return 45;
  }
  let hits = 0;
  const aliases = new Set<string>();
  kpiNames.forEach((name) => {
    aliases.add(name.toLowerCase());
    aliases.add(name.toLowerCase().replace(/_/g, " "));
  });
  aliases.forEach((alias) => {
    if (text.includes(alias)) {
      hits += 1;
    }
  });
  kpiNames.forEach((name) => {
    const parts = name.toLowerCase().split("_").filter(Boolean);
    if (parts.length >= 2) {
      const matchedParts = parts.filter((part) => text.includes(part)).length;
      if (matchedParts >= 2) {
        hits += 1;
      }
    }
  });
  return clampScore(40 + hits * 12);
};

const scoreSourceQuality = (
  doc: DocumentEntity,
  _mode: "default",
): number => {
  const provider = doc.provider.toLowerCase();
  let score = 55;
  if (provider.includes("sec")) {
    score = 85;
  } else if (provider.includes("finnhub")) {
    score = 70;
  } else if (provider.includes("alphavantage")) {
    score = 65;
  } else if (provider.includes("mock")) {
    score = 35;
  }

  if (doc.sourceType === "scrape") {
    score -= 10;
  }
  if (doc.sourceType === "manual") {
    score += 5;
  }
  return clampScore(score);
};

/**
 * Scores one candidate headline deterministically so synthesis can enforce quality gates without LLM variance.
 */
export const scoreNewsCandidate = (
  input: NewsScoringInput,
  config: NewsScoringConfig,
): NewsScoredItem => {
  const text = normalizeText(
    `${input.doc.title} ${input.doc.summary ?? ""} ${input.doc.content}`,
  );
  const titleKey = normalizeText(input.doc.title);
  const urlKey = canonicalizeUrl(input.doc.url);

  if (urlKey && input.seenUrlKeys.has(urlKey)) {
    return {
      doc: input.doc,
      evidenceClass: input.issuerMatched ? "issuer" : "industry",
      documentClass: input.issuerMatched ? "issuer_news" : "read_through_news",
      components: {
        issuerMatchScore: input.issuerMatched ? 100 : 0,
        economicMaterialityScore: 0,
        noveltyScore: 0,
        horizonRelevanceScore: 0,
        kpiLinkageScore: 0,
        sourceQualityScore: 0,
      },
      composite: 0,
      confidenceBand: "low",
      includedByThresholds: false,
      exclusionReason: "duplicate_url",
      debugReason: "duplicate_url",
      titleKey,
      urlKey,
    };
  }

  if (titleKey && input.seenTitleKeys.has(titleKey)) {
    return {
      doc: input.doc,
      evidenceClass: input.issuerMatched ? "issuer" : "industry",
      documentClass: input.issuerMatched ? "issuer_news" : "read_through_news",
      components: {
        issuerMatchScore: input.issuerMatched ? 100 : 0,
        economicMaterialityScore: 0,
        noveltyScore: 0,
        horizonRelevanceScore: 0,
        kpiLinkageScore: 0,
        sourceQualityScore: 0,
      },
      composite: 0,
      confidenceBand: "low",
      includedByThresholds: false,
      exclusionReason: "duplicate_title",
      debugReason: "duplicate_title",
      titleKey,
      urlKey,
    };
  }

  const evidenceClass = classifyEvidenceClass(text, input.issuerMatched);
  const documentClass = classifyNewsDocumentClass(text, evidenceClass);
  const issuerMatchScore = input.issuerMatched ? 100 : 20;
  const economicMaterialityScore = scoreEconomicMateriality(text);
  const noveltyScore = 85;
  const horizonRelevanceScore = scoreHorizonRelevance(text, input.horizon);
  const kpiLinkageScore = scoreKpiLinkage(text, input.kpiNames);
  const sourceQualityScore = scoreSourceQuality(input.doc, input.sourceQualityMode);
  const explicitMarketNoise = hasExplicitMarketNoisePattern(text);
  const adjacentNoise = hasAdjacentNoiseSignal(text);
  const lowMaterialityPenalty =
    economicMaterialityScore < config.minMaterialityScore ? 12 : 0;
  const lowKpiPenalty = kpiLinkageScore < config.minKpiLinkageScore ? 10 : 0;
  const adjacentPenalty = adjacentNoise ? 18 : 0;
  const readThroughPenalty = evidenceClass === "issuer" ? 0 : 8;
  const penaltyPoints =
    lowMaterialityPenalty +
    lowKpiPenalty +
    adjacentPenalty +
    readThroughPenalty;

  const composite = clampScore(
    0.34 * issuerMatchScore +
      0.22 * economicMaterialityScore +
      0.12 * noveltyScore +
      0.12 * horizonRelevanceScore +
      0.14 * kpiLinkageScore +
      0.06 * sourceQualityScore -
      penaltyPoints,
  );
  const confidenceBand = toConfidenceBand(composite, penaltyPoints);

  let exclusionReason: NewsV2ExclusionReason | undefined;
  let includedByThresholds = true;
  if (input.payloadOnlyIssuerMatch) {
    exclusionReason = "payload_only_issuer_match";
    includedByThresholds = false;
  } else if (explicitMarketNoise) {
    exclusionReason = "explicit_market_noise_pattern";
    includedByThresholds = false;
  } else if (documentClass === "market_context") {
    exclusionReason = "market_context_prefiltered";
    includedByThresholds = false;
  } else if (documentClass === "generic_market_noise") {
    exclusionReason = "generic_market_noise_prefiltered";
    includedByThresholds = false;
  } else if (sourceQualityScore < 30) {
    exclusionReason = "low_source_quality";
    includedByThresholds = false;
  } else if (composite < config.minCompositeScore) {
    exclusionReason = "below_composite_threshold";
    includedByThresholds = false;
  }

  return {
    doc: input.doc,
    evidenceClass,
    documentClass,
    components: {
      issuerMatchScore,
      economicMaterialityScore,
      noveltyScore,
      horizonRelevanceScore,
      kpiLinkageScore,
      sourceQualityScore,
    },
    composite,
    confidenceBand,
    includedByThresholds,
    exclusionReason,
    debugReason: exclusionReason,
    titleKey,
    urlKey,
  };
};
