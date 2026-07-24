import { getRequestId } from "../middleware/request-context.js";
import { logger } from "./logger.js";

/** Query acima desse tempo é considerada lenta e entra na amostra + warn log. */
const SLOW_QUERY_MS = 300;
const SLOW_QUERY_SAMPLE_SIZE = 50;
const DURATION_SAMPLE_SIZE = 500;

export interface SlowQuerySample {
  sql: string;
  durationMs: number;
  requestId: string | undefined;
  at: string;
}

interface PrismaQueryEvent {
  query: string;
  duration: number;
}

class DbMetrics {
  private count = 0;
  private totalMs = 0;
  private durations: number[] = [];
  private slowQueries: SlowQuerySample[] = [];

  record(event: PrismaQueryEvent): void {
    this.count++;
    this.totalMs += event.duration;

    this.durations.push(event.duration);
    if (this.durations.length > DURATION_SAMPLE_SIZE) this.durations.shift();

    if (event.duration >= SLOW_QUERY_MS) {
      const sample: SlowQuerySample = {
        sql: event.query.length > 300 ? `${event.query.slice(0, 300)}…` : event.query,
        durationMs: event.duration,
        requestId: getRequestId(),
        at: new Date().toISOString(),
      };
      this.slowQueries.push(sample);
      if (this.slowQueries.length > SLOW_QUERY_SAMPLE_SIZE) this.slowQueries.shift();
      logger.warn("slow_query", { durationMs: event.duration, sql: sample.sql });
    }
  }

  getStats() {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    return {
      totalQueries: this.count,
      avgMs: this.count === 0 ? 0 : this.totalMs / this.count,
      p95Ms: sorted.length === 0 ? 0 : sorted[Math.min(p95Index, sorted.length - 1)],
      slowQueryThresholdMs: SLOW_QUERY_MS,
      slowQueries: [...this.slowQueries].reverse(),
    };
  }
}

export const dbMetrics = new DbMetrics();
