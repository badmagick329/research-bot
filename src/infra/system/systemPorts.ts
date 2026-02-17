import type {
  ClockPort,
  IdGeneratorPort,
  TaskFactoryPort,
} from "../../core/ports/outboundPorts";
import type {
  JobStage,
  ResearchTaskEntity,
} from "../../core/entities/research";

/**
 * Adapts wall-clock access so time-sensitive logic remains deterministic in tests.
 */
export class SystemClock implements ClockPort {
  /**
   * Provides a single clock boundary for orchestration idempotency and snapshot timestamps.
   */
  now(): Date {
    return new Date();
  }
}

/**
 * Encapsulates identifier generation to keep persistence and orchestration independent from UUID implementation.
 */
export class UuidIdGenerator implements IdGeneratorPort {
  /**
   * Produces globally unique ids to avoid collisions across queue and storage boundaries.
   */
  next(): string {
    return crypto.randomUUID();
  }
}

/**
 * Centralizes task-id/idempotency policy so every enqueue path follows the same deduplication contract.
 */
export class TaskFactory implements TaskFactoryPort {
  constructor(
    private readonly clock: ClockPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  /**
   * Creates canonical task metadata used by queueing and observability flows.
   * Uses hyphen delimiters because BullMQ custom job ids cannot include colon.
   */
  create(symbol: string, stage: JobStage): ResearchTaskEntity {
    const id = this.ids.next();
    const now = this.clock.now();
    const hourBucket = now.toISOString().slice(0, 13);
    return {
      id,
      symbol: symbol.toUpperCase(),
      requestedAt: now,
      priority: 3,
      stage,
      idempotencyKey: `${symbol.toUpperCase()}-${stage}-${hourBucket}`,
    };
  }
}
