import type {
  FilingsProviderPort,
  FilingsRequest,
  NormalizedFiling,
} from "../../../core/ports/inboundPorts";

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
  ) {
    if (!this.userAgent.trim()) {
      throw new Error(
        "SEC_EDGAR_USER_AGENT is required when SEC EDGAR filings provider is enabled.",
      );
    }
  }

  /**
   * Returns normalized filings for the requested window and shields ingestion from transient SEC transport errors.
   */
  async fetchFilings(request: FilingsRequest): Promise<NormalizedFiling[]> {
    try {
      const symbol = request.symbol.toUpperCase();
      const cik = await this.resolveCik(symbol);
      if (!cik) {
        return [];
      }

      const submission = await this.fetchSubmission(cik);
      if (!submission) {
        return [];
      }

      return this.toNormalizedFilings(symbol, request, cik, submission);
    } catch {
      return [];
    }
  }

  /**
   * Caches ticker-to-CIK lookups to reduce repeated SEC metadata calls during worker runs.
   */
  private async resolveCik(symbol: string): Promise<string | null> {
    const cached = this.symbolToCik.get(symbol);
    if (cached) {
      return cached;
    }

    const response = await this.fetchJson<EdgarTickersResponse>(
      this.tickersUrl,
    );
    if (!response) {
      return null;
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

    return this.symbolToCik.get(symbol) ?? null;
  }

  /**
   * Pulls SEC submission history for a resolved CIK to access recent filing metadata.
   */
  private async fetchSubmission(
    cik: string,
  ): Promise<EdgarSubmissionResponse | null> {
    const url = new URL(`/submissions/CIK${cik}.json`, this.baseUrl).toString();
    return this.fetchJson<EdgarSubmissionResponse>(url);
  }

  /**
   * Converts SEC recent-filing arrays into bounded, date-filtered normalized filings.
   */
  private toNormalizedFilings(
    symbol: string,
    request: FilingsRequest,
    cik: string,
    submission: EdgarSubmissionResponse,
  ): NormalizedFiling[] {
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
        sections,
        extractedFacts,
        rawPayload: {
          filingType,
          accessionNo,
          filingDate: filingDates[index],
          reportDate: reportDates[index],
          primaryDocument,
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
   * Applies SEC-required headers and timeout handling consistently for all EDGAR requests.
   */
  private async fetchJson<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
