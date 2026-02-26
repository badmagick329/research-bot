import type {
  FilingsProviderPort,
  FilingsRequest,
  NormalizedFiling,
} from "../../../core/ports/inboundPorts";
import type { AppBoundaryError } from "../../../core/entities/appError";
import type { ProviderRateLimiterPort } from "../../../core/ports/outboundPorts";
import { err, ok, type Result } from "neverthrow";
import { HttpJsonClient } from "../../http/httpJsonClient";

const noOpRateLimiter: ProviderRateLimiterPort = {
  waitForSlot: async () => {},
};

type EdgarTickerRecord = {
  ticker?: string;
  cik_str?: number;
};

type EdgarTickersResponse = Record<string, EdgarTickerRecord>;

type EdgarRecentFilings = {
  form?: string[];
  accessionNumber?: string[];
  filingDate?: string[];
  reportDate?: string[];
  primaryDocument?: string[];
};

type EdgarSubmissionResponse = {
  name?: string;
  filings?: {
    recent?: EdgarRecentFilings;
  };
};

const allowedForms = new Set([
  "10-K",
  "10-Q",
  "8-K",
  "20-F",
  "6-K",
  "S-1",
  "424B2",
]);

const asDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const asAccessionPathPart = (accessionNo: string): string =>
  accessionNo.replaceAll("-", "");

const MAX_FILING_BYTES = 900_000;
const FILING_TEXT_SNIPPET_LIMIT = 520;
const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

type SecEdgarFilingsError =
  | { code: "config_invalid"; message: string }
  | {
      code: "http_failure";
      message: string;
      errorCode:
        | "timeout"
        | "transport_error"
        | "non_success_status"
        | "invalid_json";
      httpStatus?: number;
      retryable: boolean;
      cause?: unknown;
    }
  | { code: "malformed_response"; message: string; cause?: unknown };

/**
 * Adapts SEC EDGAR submissions into normalized filings while preserving provider traceability fields.
 */
export class SecEdgarFilingsProvider implements FilingsProviderPort {
  private readonly symbolToCik = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly archivesBaseUrl: string,
    private readonly tickersUrl: string,
    private readonly userAgent: string,
    private readonly timeoutMs = 15_000,
    private readonly httpClient = new HttpJsonClient(),
    private readonly providerRateLimiter: ProviderRateLimiterPort = noOpRateLimiter,
  ) {
    if (!this.userAgent.trim()) {
      throw new Error(
        "SEC_EDGAR_USER_AGENT is required when SEC EDGAR filings provider is enabled.",
      );
    }
  }

  /**
   * Returns normalized filings for the requested window and surfaces upstream failures as typed boundary errors.
   */
  async fetchFilings(
    request: FilingsRequest,
  ): Promise<Result<NormalizedFiling[], AppBoundaryError>> {
    const symbol = request.symbol.toUpperCase();
    const cikResult = await this.resolveCik(symbol);
    if (cikResult.isErr()) {
      return err(this.mapToBoundaryError(cikResult.error, symbol));
    }

    if (!cikResult.value) {
      return ok([]);
    }

    const submissionResult = await this.fetchSubmission(cikResult.value);
    if (submissionResult.isErr()) {
      return err(this.mapToBoundaryError(submissionResult.error, symbol));
    }

    if (!submissionResult.value) {
      return ok([]);
    }

    return ok(
      await this.toNormalizedFilings(
        symbol,
        request,
        cikResult.value,
        submissionResult.value,
      ),
    );
  }

  /**
   * Caches ticker-to-CIK lookups to reduce repeated SEC metadata calls during worker runs.
   */
  private async resolveCik(
    symbol: string,
  ): Promise<Result<string | null, SecEdgarFilingsError>> {
    const cached = this.symbolToCik.get(symbol);
    if (cached) {
      return ok(cached);
    }

    const responseResult = await this.fetchJson<EdgarTickersResponse>(
      this.tickersUrl,
    );
    if (responseResult.isErr()) {
      return err(responseResult.error);
    }

    const response = responseResult.value;

    if (!response || typeof response !== "object") {
      return err({
        code: "malformed_response",
        message: "SEC ticker mapping payload was malformed.",
      });
    }

    for (const record of Object.values(response)) {
      const ticker = record.ticker?.trim().toUpperCase();
      if (!ticker) {
        continue;
      }

      const cikValue = record.cik_str;
      if (!Number.isInteger(cikValue)) {
        continue;
      }

      const cik = String(cikValue).padStart(10, "0");
      this.symbolToCik.set(ticker, cik);
    }

    return ok(this.symbolToCik.get(symbol) ?? null);
  }

  /**
   * Pulls SEC submission history for a resolved CIK to access recent filing metadata.
   */
  private async fetchSubmission(
    cik: string,
  ): Promise<Result<EdgarSubmissionResponse | null, SecEdgarFilingsError>> {
    const url = new URL(`/submissions/CIK${cik}.json`, this.baseUrl).toString();
    return this.fetchJson<EdgarSubmissionResponse>(url);
  }

  /**
   * Converts SEC recent-filing arrays into bounded, date-filtered normalized filings.
   */
  private async toNormalizedFilings(
    symbol: string,
    request: FilingsRequest,
    cik: string,
    submission: EdgarSubmissionResponse,
  ): Promise<NormalizedFiling[]> {
    const recent = submission.filings?.recent;
    const forms = recent?.form ?? [];
    const accessionNumbers = recent?.accessionNumber ?? [];
    const filingDates = recent?.filingDate ?? [];
    const reportDates = recent?.reportDate ?? [];
    const primaryDocuments = recent?.primaryDocument ?? [];

    const results: NormalizedFiling[] = [];

    for (let index = 0; index < forms.length; index += 1) {
      if (results.length >= request.limit) {
        break;
      }

      const filingType = forms[index]?.trim().toUpperCase();
      const accessionNo = accessionNumbers[index]?.trim();
      const filingDate = asDate(filingDates[index]);
      const periodEnd = asDate(reportDates[index]) ?? undefined;
      const primaryDocument = primaryDocuments[index]?.trim();

      if (!filingType || !allowedForms.has(filingType)) {
        continue;
      }

      if (!accessionNo || !filingDate || !primaryDocument) {
        continue;
      }

      if (filingDate < request.from || filingDate > request.to) {
        continue;
      }

      const docUrl = `${this.archivesBaseUrl}/${Number.parseInt(cik, 10)}/${asAccessionPathPart(accessionNo)}/${primaryDocument}`;
      const sections = this.buildDerivedSections(
        filingType,
        filingDate,
        periodEnd,
        primaryDocument,
      );
      const extractedFacts = this.buildDerivedFacts(
        filingType,
        filingDate,
        periodEnd,
        accessionNo,
      );
      const extraction = await this.extractFilingSignals(docUrl, filingType);

      results.push({
        id: `sec-edgar-${symbol}-${accessionNo}`,
        provider: "sec-edgar",
        symbol,
        issuerName: submission.name?.trim() || symbol,
        filingType,
        accessionNo,
        filedAt: filingDate,
        periodEnd,
        docUrl,
        sections: [...sections, ...extraction.sections],
        extractedFacts: [...extractedFacts, ...extraction.facts],
        rawPayload: {
          filingType,
          accessionNo,
          filingDate: filingDates[index],
          reportDate: reportDates[index],
          primaryDocument,
          extractionStatus: extraction.status,
          extractionReason: extraction.reason,
        },
      });
    }

    return results;
  }

  /**
   * Derives compact filing sections from SEC metadata so synthesis gets structured filing context even without full-text parsing.
   */
  private buildDerivedSections(
    filingType: string,
    filingDate: Date,
    periodEnd: Date | undefined,
    primaryDocument: string,
  ): Array<{ name: string; text: string }> {
    const overviewText = [
      `Form ${filingType} filed on ${filingDate.toISOString().slice(0, 10)}.`,
      periodEnd
        ? `Reported period end: ${periodEnd.toISOString().slice(0, 10)}.`
        : "Reported period end: unavailable.",
      `Primary SEC document: ${primaryDocument}.`,
    ].join(" ");

    return [
      {
        name: "edgar_metadata_overview",
        text: overviewText,
      },
    ];
  }

  /**
   * Emits normalized filing facts from EDGAR metadata so downstream prompts can reference concrete filing attributes.
   */
  private buildDerivedFacts(
    filingType: string,
    filingDate: Date,
    periodEnd: Date | undefined,
    accessionNo: string,
  ): Array<{ name: string; value: string; unit?: string; period?: string }> {
    return [
      {
        name: "filing_type",
        value: filingType,
      },
      {
        name: "filing_date",
        value: filingDate.toISOString().slice(0, 10),
      },
      {
        name: "accession_number",
        value: accessionNo,
      },
      {
        name: "reported_period_end",
        value: periodEnd ? periodEnd.toISOString().slice(0, 10) : "unavailable",
      },
    ];
  }

  /**
   * Fetches filing text within strict bounds and derives deterministic section/fact signals.
   */
  private async extractFilingSignals(
    docUrl: string,
    filingType: string,
  ): Promise<{
    sections: Array<{ name: string; text: string }>;
    facts: Array<{ name: string; value: string; unit?: string; period?: string }>;
    status: "parsed" | "metadata_only";
    reason?: string;
  }> {
    const fallback = {
      sections: [] as Array<{ name: string; text: string }>,
      facts: [
        {
          name: "content_extraction_status",
          value: "metadata_only",
        },
      ] as Array<{ name: string; value: string; unit?: string; period?: string }>,
      status: "metadata_only" as const,
      reason: undefined as string | undefined,
    };

    try {
      await this.providerRateLimiter.waitForSlot("sec-edgar");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const response = await fetch(docUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { ...fallback, reason: `content_fetch_http_${response.status}` };
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (
        contentType.includes("pdf") ||
        contentType.includes("zip") ||
        contentType.includes("octet-stream")
      ) {
        return { ...fallback, reason: "unsupported_content_type" };
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FILING_BYTES) {
        return { ...fallback, reason: "content_too_large" };
      }

      const rawText = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const normalizedText = stripHtml(rawText).toLowerCase();
      if (!normalizedText || normalizedText.length < 60) {
        return { ...fallback, reason: "content_unparseable" };
      }

      const riskSnippet = this.extractSnippet(normalizedText, [
        "risk factor",
        "material weakness",
        "uncertainty",
      ]);
      const guidanceSnippet = this.extractSnippet(normalizedText, [
        "guidance",
        "outlook",
        "forecast",
      ]);
      const liquiditySnippet = this.extractSnippet(normalizedText, [
        "liquidity",
        "cash flow",
        "working capital",
      ]);
      const regulatorySnippet = this.extractSnippet(normalizedText, [
        "investigation",
        "litigation",
        "regulatory",
        "compliance",
      ]);

      const facts = [
        {
          name: "mentions_risk_factor_change",
          value: String(/risk factor|material weakness|uncertainty/.test(normalizedText)),
        },
        {
          name: "mentions_guidance_update",
          value: String(/guidance|outlook|forecast/.test(normalizedText)),
        },
        {
          name: "mentions_margin_pressure",
          value: String(/margin pressure|gross margin decline|operating margin decline/.test(normalizedText)),
        },
        {
          name: "mentions_demand_strength",
          value: String(/strong demand|demand remained strong|record demand/.test(normalizedText)),
        },
        {
          name: "mentions_regulatory_action",
          value: String(/investigation|litigation|regulatory action|subpoena/.test(normalizedText)),
        },
        {
          name: "content_extraction_status",
          value: "parsed",
        },
      ];

      const sections = [
        { name: "risk_factor_signals", text: riskSnippet },
        { name: "guidance_signals", text: guidanceSnippet },
        { name: "liquidity_signals", text: liquiditySnippet },
        { name: "legal_regulatory_signals", text: regulatorySnippet },
      ].filter((section) => section.text.length > 0);

      return {
        sections,
        facts,
        status: "parsed",
      };
    } catch {
      return { ...fallback, reason: `${filingType.toLowerCase()}_content_parse_error` };
    }
  }

  /**
   * Extracts a bounded context snippet around the earliest keyword hit to keep filing evidence concise and deterministic.
   */
  private extractSnippet(text: string, keywords: string[]): string {
    const hitIndex = keywords
      .map((keyword) => text.indexOf(keyword))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];

    if (typeof hitIndex !== "number") {
      return "";
    }

    const start = Math.max(0, hitIndex - 120);
    const end = Math.min(text.length, hitIndex + FILING_TEXT_SNIPPET_LIMIT);
    return text.slice(start, end).trim();
  }

  /**
   * Applies SEC-required headers and timeout handling consistently for all EDGAR requests.
   */
  private async fetchJson<T>(
    url: string,
  ): Promise<Result<T | null, SecEdgarFilingsError>> {
    const response = await this.httpClient.requestJson<T>({
      url,
      method: "GET",
      timeoutMs: this.timeoutMs,
      retries: 2,
      retryDelayMs: 300,
      beforeAttempt: async () => {
        await this.providerRateLimiter.waitForSlot("sec-edgar");
      },
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });

    if (response.isErr()) {
      if (response.error.httpStatus === 404) {
        return ok(null);
      }

      return err({
        code: "http_failure",
        message: response.error.message,
        errorCode: response.error.code,
        httpStatus: response.error.httpStatus,
        retryable: response.error.retryable,
        cause: response.error.cause,
      });
    }

    return ok(response.value);
  }

  private mapToBoundaryError(
    failure: SecEdgarFilingsError,
    symbol: string,
  ): AppBoundaryError {
    if (failure.code === "config_invalid") {
      return {
        source: "filings",
        code: "config_invalid",
        provider: "sec-edgar",
        message: failure.message,
        retryable: false,
        cause: { symbol },
      };
    }

    if (failure.code === "malformed_response") {
      return {
        source: "filings",
        code: "malformed_response",
        provider: "sec-edgar",
        message: failure.message,
        retryable: false,
        cause: failure.cause,
      };
    }

    return {
      source: "filings",
      code: this.mapHttpCode(
        failure.httpStatus,
        failure.message,
        failure.errorCode,
      ),
      provider: "sec-edgar",
      message: failure.message,
      retryable: failure.retryable,
      httpStatus: failure.httpStatus,
      cause: failure.cause,
    };
  }

  private mapHttpCode(
    httpStatus: number | undefined,
    message: string,
    errorCode:
      | "timeout"
      | "transport_error"
      | "non_success_status"
      | "invalid_json",
  ): AppBoundaryError["code"] {
    if (httpStatus === 429) {
      return "rate_limited";
    }

    if (httpStatus === 401 || httpStatus === 403) {
      return "auth_invalid";
    }

    if (errorCode === "invalid_json") {
      return "invalid_json";
    }

    if (errorCode === "timeout") {
      return "timeout";
    }

    if (/timed out/i.test(message)) {
      return "timeout";
    }

    return "provider_error";
  }
}
