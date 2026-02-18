export type MetricPeriodType = "ttm" | "quarter" | "annual" | "point_in_time";

export type MetricPointEntity = {
  id: string;
  runId?: string;
  taskId?: string;
  symbol: string;
  provider: string;
  metricName: string;
  metricValue: number;
  metricUnit?: string;
  currency?: string;
  asOf: Date;
  periodType: MetricPeriodType;
  periodStart?: Date;
  periodEnd?: Date;
  confidence?: number;
  rawPayload: unknown;
  createdAt: Date;
};
