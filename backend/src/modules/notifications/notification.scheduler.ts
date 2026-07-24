import { RequirementCollectionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  sendExpiryDigest,
  type ExpiryItem,
} from "./notification.service.js";
import { logger } from "../../lib/logger.js";
import {
  registerScheduler,
  withSchedulerTracking,
} from "../../lib/scheduler-health.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x por dia

let intervalRef: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  const in7Days = new Date(Date.now() + 7 * 24 * 3_600_000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3_600_000);

  // -------------------------------------------------------------------------
  // Worker requirement items: expirando nos próximos 7 dias
  // -------------------------------------------------------------------------
  // A empreiteira vem pelo vínculo (assignment) do colaborador — o modelo Worker
  // não tem mais contractor direto desde a migração para WorkerAssignment.
  const itemSelect = {
    id: true,
    name: true,
    expiresAt: true,
    companyId: true,
    worker: { select: { fullName: true } },
    assignment: {
      select: {
        contractor: { select: { id: true, name: true, email: true } },
      },
    },
  } as const;

  const expiringSoon = await prisma.workerRequirementItem.findMany({
    where: {
      status: RequirementCollectionStatus.APPROVED,
      expiresAt: { gte: now, lte: in7Days },
    },
    select: itemSelect,
  });

  // Worker requirement items: já vencidos (últimos 30 dias para não notificar indefinidamente)
  const expired = await prisma.workerRequirementItem.findMany({
    where: {
      status: RequirementCollectionStatus.APPROVED,
      expiresAt: { gte: thirtyDaysAgo, lt: now },
    },
    select: itemSelect,
  });

  // -------------------------------------------------------------------------
  // Agrupa por (companyId, contractorId) e envia um digest por empreiteira
  // -------------------------------------------------------------------------
  await processGroup(expiringSoon, false);
  await processGroup(expired, true);
}

type ItemRow = {
  name: string;
  expiresAt: Date | null;
  companyId: string;
  worker: { fullName: string };
  assignment: {
    contractor: { id: string; name: string; email: string | null };
  } | null;
};

async function processGroup(items: ItemRow[], expired: boolean): Promise<void> {
  // Agrupa por contractor (mesma empreiteira pode ter vários items)
  const byContractor = new Map<
    string,
    { companyId: string; contractor: { id: string; name: string; email: string }; items: ExpiryItem[] }
  >();

  for (const item of items) {
    const c = item.assignment?.contractor;
    if (!c || !c.email || !item.expiresAt) continue;

    const key = c.id;
    if (!byContractor.has(key)) {
      byContractor.set(key, {
        companyId: item.companyId,
        contractor: { id: c.id, name: c.name, email: c.email },
        items: [],
      });
    }
    byContractor.get(key)!.items.push({
      workerOrContractorName: item.worker.fullName,
      documentName: item.name,
      expiresAt: item.expiresAt,
    });
  }

  let sent = 0;
  for (const { companyId, contractor, items: digestItems } of byContractor.values()) {
    await sendExpiryDigest({
      companyId,
      contractorId: contractor.id,
      contractorName: contractor.name,
      contractorEmail: contractor.email,
      items: digestItems,
      expired,
    });
    sent++;
  }

  if (sent > 0) {
    const label = expired ? "vencidos" : "vencendo";
    logger.info("notification_digest_sent", { count: sent, label });
  }
}

const SCHEDULER_NAME = "notifications";
registerScheduler(SCHEDULER_NAME);

export function startNotificationScheduler(): void {
  if (intervalRef) return;

  const run = async () => {
    try {
      await withSchedulerTracking(SCHEDULER_NAME, tick);
    } catch (e) {
      logger.error("notification_tick_failed", { err: e });
    }
  };

  // Roda 60s após o boot e depois 1x por dia
  setTimeout(() => void run(), 60_000);
  intervalRef = setInterval(() => void run(), CHECK_INTERVAL_MS);
}

export function stopNotificationScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }
}
