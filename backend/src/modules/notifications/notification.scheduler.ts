import { RequirementCollectionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  sendExpiryDigest,
  type ExpiryItem,
} from "./notification.service.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x por dia

let intervalRef: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  const in7Days = new Date(Date.now() + 7 * 24 * 3_600_000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3_600_000);

  // -------------------------------------------------------------------------
  // Worker requirement items: expirando nos próximos 7 dias
  // -------------------------------------------------------------------------
  const expiringSoon = await prisma.workerRequirementItem.findMany({
    where: {
      status: RequirementCollectionStatus.APPROVED,
      expiresAt: { gte: now, lte: in7Days },
    },
    select: {
      id: true,
      name: true,
      expiresAt: true,
      companyId: true,
      worker: {
        select: {
          fullName: true,
          contractor: {
            select: { id: true, name: true, email: true },
          },
        },
      },
    },
  });

  // Worker requirement items: já vencidos (últimos 30 dias para não notificar indefinidamente)
  const expired = await prisma.workerRequirementItem.findMany({
    where: {
      status: RequirementCollectionStatus.APPROVED,
      expiresAt: { gte: thirtyDaysAgo, lt: now },
    },
    select: {
      id: true,
      name: true,
      expiresAt: true,
      companyId: true,
      worker: {
        select: {
          fullName: true,
          contractor: {
            select: { id: true, name: true, email: true },
          },
        },
      },
    },
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
  worker: {
    fullName: string;
    contractor: { id: string; name: string; email: string | null };
  };
};

async function processGroup(items: ItemRow[], expired: boolean): Promise<void> {
  // Agrupa por contractor (mesma empreiteira pode ter vários items)
  const byContractor = new Map<
    string,
    { companyId: string; contractor: { id: string; name: string; email: string }; items: ExpiryItem[] }
  >();

  for (const item of items) {
    const c = item.worker.contractor;
    if (!c.email || !item.expiresAt) continue;

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
    // eslint-disable-next-line no-console
    console.log(`[notifications] ${sent} digest(s) de documentos ${label} enviado(s).`);
  }
}

export function startNotificationScheduler(): void {
  if (intervalRef) return;

  const run = async () => {
    try {
      await tick();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[notifications] erro no tick:", e);
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
