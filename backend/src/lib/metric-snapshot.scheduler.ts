import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { requestMetrics } from "./metrics.js";
import { registerScheduler, withSchedulerTracking } from "./scheduler-health.js";

const SAMPLE_INTERVAL_MS = 60 * 1000; // amostra em memória a cada 1 min
const PERSIST_EVERY_N_SAMPLES = 5; // grava no Postgres a cada 5 min
const SCHEDULER_NAME = "metric-snapshot";
registerScheduler(SCHEDULER_NAME);

let intervalRef: ReturnType<typeof setInterval> | null = null;
let sampleCount = 0;

async function tick(): Promise<void> {
  const snapshot = requestMetrics.takeSnapshot();
  sampleCount++;
  if (sampleCount % PERSIST_EVERY_N_SAMPLES !== 0) return;

  await prisma.metricSnapshot.create({
    data: {
      takenAt: new Date(snapshot.takenAt),
      rssMb: snapshot.rssMb,
      heapUsedMb: snapshot.heapUsedMb,
      cpuUserPct: snapshot.cpuUserPct,
      requestsPerMin: snapshot.requestsPerMin,
      avgLatencyMs: snapshot.avgLatencyMs,
      errorRate: snapshot.errorRate,
    },
  });
}

/** Amostra métricas de processo a cada 1 min (memória) e persiste 1 a cada 5 min (Postgres). */
export function startMetricSnapshotScheduler(): void {
  if (intervalRef) return;

  const run = async () => {
    try {
      await withSchedulerTracking(SCHEDULER_NAME, tick);
    } catch (e) {
      logger.error("metric_snapshot_tick_failed", { err: e });
    }
  };

  void run();
  intervalRef = setInterval(() => void run(), SAMPLE_INTERVAL_MS);
}

export function stopMetricSnapshotScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }
}
