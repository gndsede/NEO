import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { requestMetrics } from "./metrics.js";
import { dbMetrics } from "./db-metrics.js";
import { checkDatabase } from "./health-check.js";
import { sendAlertEmail } from "./alert-email.js";
import { registerScheduler, withSchedulerTracking } from "./scheduler-health.js";

const CHECK_INTERVAL_MS = 60 * 1000; // 1 min
const SCHEDULER_NAME = "alerts";
registerScheduler(SCHEDULER_NAME);

export const ALERT_METRICS = [
  "ERROR_RATE",
  "P95_LATENCY_MS",
  "SLOW_QUERY_COUNT",
  "DB_DOWN",
  "MEMORY_RSS_MB",
] as const;

export type AlertMetric = (typeof ALERT_METRICS)[number];

const METRIC_LABELS: Record<AlertMetric, string> = {
  ERROR_RATE: "Taxa de erro (%)",
  P95_LATENCY_MS: "Latência p95 (ms)",
  SLOW_QUERY_COUNT: "Queries lentas (amostra recente)",
  DB_DOWN: "Banco de dados indisponível",
  MEMORY_RSS_MB: "Memória RSS (MB)",
};

/** Valor atual de uma métrica suportada, na mesma unidade do threshold configurado. */
async function currentMetricValue(metric: string): Promise<number> {
  switch (metric as AlertMetric) {
    case "ERROR_RATE":
      return requestMetrics.getOverallStats().errorRate * 100;
    case "P95_LATENCY_MS":
      return requestMetrics.getOverallStats().p95Ms;
    case "SLOW_QUERY_COUNT":
      return dbMetrics.getStats().slowQueries.length;
    case "DB_DOWN": {
      const health = await checkDatabase();
      return health.ok ? 0 : 1;
    }
    case "MEMORY_RSS_MB":
      return requestMetrics.getLatestSnapshot()?.rssMb ?? 0;
    default:
      return 0;
  }
}

async function evaluateRule(rule: {
  id: string;
  metric: string;
  threshold: number;
  recipientEmail: string;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
}): Promise<void> {
  const value = await currentMetricValue(rule.metric);
  if (value <= rule.threshold) return;

  if (rule.lastTriggeredAt) {
    const cooldownMs = rule.cooldownMinutes * 60 * 1000;
    if (Date.now() - rule.lastTriggeredAt.getTime() < cooldownMs) return;
  }

  const label = METRIC_LABELS[rule.metric as AlertMetric] ?? rule.metric;
  const message = `${label} está em ${value.toFixed(2)}, acima do limite configurado de ${rule.threshold}.`;

  logger.warn("alert_triggered", { ruleId: rule.id, metric: rule.metric, value });

  await prisma.$transaction([
    prisma.alertEvent.create({
      data: { ruleId: rule.id, metricValue: value, message },
    }),
    prisma.alertRule.update({
      where: { id: rule.id },
      data: { lastTriggeredAt: new Date() },
    }),
  ]);

  await sendAlertEmail({
    recipientEmail: rule.recipientEmail,
    metric: label,
    threshold: rule.threshold,
    currentValue: value,
    message,
  });
}

async function tick(): Promise<void> {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
  for (const rule of rules) {
    await evaluateRule(rule);
  }
}

let intervalRef: ReturnType<typeof setInterval> | null = null;

export function startAlertScheduler(): void {
  if (intervalRef) return;

  const run = async () => {
    try {
      await withSchedulerTracking(SCHEDULER_NAME, tick);
    } catch (e) {
      logger.error("alert_tick_failed", { err: e });
    }
  };

  setTimeout(() => void run(), 45_000);
  intervalRef = setInterval(() => void run(), CHECK_INTERVAL_MS);
}

export function stopAlertScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }
}
