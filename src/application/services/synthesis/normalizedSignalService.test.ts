import { describe, expect, it } from "bun:test";
import type { MetricPointEntity } from "../../../core/entities/metric";
import { DeterministicNormalizedSignalService } from "./normalizedSignalService";

const metric = (args: Partial<MetricPointEntity> & Pick<MetricPointEntity, "metricName" | "metricValue" | "asOf">): MetricPointEntity => ({
  ...args,
  id: `m-${args.metricName}-${args.asOf.getTime()}`,
  symbol: "AMZN",
  provider: "test",
  metricName: args.metricName,
  metricValue: args.metricValue,
  asOf: args.asOf,
  periodType: "quarter",
  rawPayload: {},
  createdAt: args.asOf,
});

describe("DeterministicNormalizedSignalService", () => {
  it("produces deterministic signals for identical inputs", () => {
    const now = new Date("2026-03-02T00:00:00Z");
    const metrics: MetricPointEntity[] = [
      metric({ metricName: "revenue_growth_yoy", metricValue: 0.22, asOf: new Date("2026-02-25T00:00:00Z") }),
      metric({ metricName: "revenue_growth_yoy", metricValue: 0.18, asOf: new Date("2025-11-25T00:00:00Z") }),
      metric({ metricName: "price_to_earnings", metricValue: 34, asOf: new Date("2026-02-25T00:00:00Z") }),
      metric({ metricName: "price_to_earnings", metricValue: 39, asOf: new Date("2025-11-25T00:00:00Z") }),
    ];
    const service = new DeterministicNormalizedSignalService();

    const first = service.buildSignalPack({ metrics, now, selectedKpiNames: ["revenue_growth_yoy", "price_to_earnings"] });
    const second = service.buildSignalPack({ metrics, now, selectedKpiNames: ["revenue_growth_yoy", "price_to_earnings"] });

    expect(first).toEqual(second);
    expect(first.coverage.totalSignals).toBeGreaterThan(0);
  });

  it("does not increase sufficiency input quality when evidence freshness degrades", () => {
    const now = new Date("2026-03-02T00:00:00Z");
    const service = new DeterministicNormalizedSignalService();
    const fresh = service.buildSignalPack({
      metrics: [
        metric({ metricName: "profit_margin", metricValue: 0.18, asOf: new Date("2026-02-20T00:00:00Z") }),
        metric({ metricName: "profit_margin", metricValue: 0.16, asOf: new Date("2025-11-20T00:00:00Z") }),
      ],
      now,
      selectedKpiNames: ["profit_margin"],
    });
    const stale = service.buildSignalPack({
      metrics: [
        metric({ metricName: "profit_margin", metricValue: 0.18, asOf: new Date("2025-03-01T00:00:00Z") }),
        metric({ metricName: "profit_margin", metricValue: 0.16, asOf: new Date("2024-12-01T00:00:00Z") }),
      ],
      now,
      selectedKpiNames: ["profit_margin"],
    });

    expect(fresh.coverage.freshSignals).toBeGreaterThan(stale.coverage.freshSignals);
  });
});
