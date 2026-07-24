import os from "node:os";
import { prisma } from "../../../lib/prisma.js";
import { env } from "../../../config/env.js";
import { checkDatabase } from "../../../lib/health-check.js";
import { getSchedulerHealth } from "../../../lib/scheduler-health.js";
import { cache } from "../../../lib/cache.js";
import { dbMetrics } from "../../../lib/db-metrics.js";
import { requestMetrics } from "../../../lib/metrics.js";

/**
 * Status detalhado do sistema para o painel super-admin — não confundir com
 * `GET /health` (raiz, público, usado pelo Railway, propositalmente simples).
 */
export async function getDetailedHealth() {
  const [db] = await Promise.all([checkDatabase()]);
  const mem = process.memoryUsage();
  const schedulers = getSchedulerHealth();

  const schedulerNames = Object.keys(schedulers);
  const anySchedulerFailing = schedulerNames.some((name) => schedulers[name].lastOk === false);

  const status: "ok" | "degraded" = db.ok && !anySchedulerFailing ? "ok" : "degraded";

  return {
    status,
    db,
    process: {
      uptimeSeconds: process.uptime(),
      nodeVersion: process.version,
      rssMb: mem.rss / (1024 * 1024),
      heapUsedMb: mem.heapUsed / (1024 * 1024),
      heapTotalMb: mem.heapTotal / (1024 * 1024),
      platform: os.platform(),
    },
    schedulers,
    cache: cache.getStats(),
    storage: { driver: env.STORAGE_DRIVER },
    deploy: {
      nodeEnv: env.NODE_ENV,
      commitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    },
  };
}

export async function getPerformanceMetrics() {
  const persistedHistory = await prisma.metricSnapshot.findMany({
    orderBy: { takenAt: "desc" },
    take: 120,
  });

  return {
    current: requestMetrics.getLatestSnapshot() ?? null,
    overall: requestMetrics.getOverallStats(),
    routeStats: requestMetrics.getRouteStats(),
    history: requestMetrics.getSnapshotHistory(),
    persistedHistory: persistedHistory.reverse(),
  };
}

export function getDbMetrics() {
  return dbMetrics.getStats();
}

export function getCacheMetrics() {
  return cache.getStats();
}

export async function listErrors(params: { take: number; statusCode?: number }) {
  return prisma.errorLog.findMany({
    where: params.statusCode ? { statusCode: params.statusCode } : undefined,
    orderBy: { createdAt: "desc" },
    take: params.take,
  });
}
