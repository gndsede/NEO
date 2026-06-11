import { AccessDirection, AccessResult } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

const ENTRY_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 horas
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // a cada 15 min

/**
 * Para cada ENTRY GRANTED sem EXIT posterior do mesmo worker e com mais de
 * 8 horas, insere um EXIT automático no instante do limite (entrada + 8h).
 * Útil quando o porteiro esquece de registrar a saída.
 */
export async function runAutoExitOnce(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ENTRY_MAX_AGE_MS);

  // Pega entradas com mais de 8h. Para cada uma, vamos verificar se já existe
  // um EXIT posterior do mesmo worker (manual ou automático).
  const candidates = await prisma.accessLog.findMany({
    where: {
      direction: AccessDirection.ENTRY,
      result: AccessResult.GRANTED,
      occurredAt: { lte: cutoff },
      workerId: { not: null },
    },
    select: {
      id: true,
      companyId: true,
      workerId: true,
      occurredAt: true,
      gate: true,
    },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });

  let inserted = 0;

  for (const entry of candidates) {
    if (!entry.workerId) continue;

    const laterLog = await prisma.accessLog.findFirst({
      where: {
        workerId: entry.workerId,
        result: AccessResult.GRANTED,
        occurredAt: { gt: entry.occurredAt },
      },
      select: { id: true, direction: true },
      orderBy: { occurredAt: "asc" },
    });

    // Se já existe qualquer log posterior, nada a fazer:
    // - Se for EXIT, a saída foi registrada.
    // - Se for ENTRY, alguém já abriu nova sessão (o estado virou par).
    if (laterLog) continue;

    const autoExitAt = new Date(entry.occurredAt.getTime() + ENTRY_MAX_AGE_MS);

    await prisma.accessLog.create({
      data: {
        companyId: entry.companyId,
        workerId: entry.workerId,
        direction: AccessDirection.EXIT,
        result: AccessResult.GRANTED,
        gate: entry.gate,
        qrHash: null,
        operatorId: null,
        occurredAt: autoExitAt,
        reason: "Saída automática após 8h sem registro manual",
      },
    });
    inserted++;
  }

  return inserted;
}

let intervalRef: ReturnType<typeof setInterval> | null = null;

export function startAutoExitScheduler(): void {
  if (intervalRef) return;

  const tick = async () => {
    try {
      const inserted = await runAutoExitOnce();
      if (inserted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[auto-exit] ${inserted} saída(s) automática(s) registrada(s).`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[auto-exit] erro no tick:", e);
    }
  };

  // Roda 30 segundos depois do boot e a cada 15 minutos.
  setTimeout(() => void tick(), 30_000);
  intervalRef = setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

export function stopAutoExitScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }
}
