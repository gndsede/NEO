import { AccessDirection, AccessResult } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/** Fallback quando o colaborador não tem turno cadastrado. */
const FALLBACK_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 horas
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min

const SHIFT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface ShiftLike {
  shiftStart: string | null;
  shiftEnd: string | null;
}

/**
 * Instante em que a saída automática deve ser registrada a partir do ENTRY.
 *
 * - Com `shiftEnd`: aplica esse horário no dia do ENTRY (ou no seguinte, se for
 *   turno noturno — i.e. shiftEnd < shiftStart). Se o instante calculado ficar
 *   antes do ENTRY (ex.: ENTRY 23:00 e shiftEnd 22:00 sem shiftStart), soma 24h.
 * - Sem `shiftEnd`: ENTRY + 8h (compatibilidade).
 */
export function autoExitInstant(entryAt: Date, worker: ShiftLike): Date {
  const end = worker.shiftEnd;
  if (!end || !SHIFT_TIME_RE.test(end)) {
    return new Date(entryAt.getTime() + FALLBACK_MAX_AGE_MS);
  }
  const [, endHh, endMm] = end.match(SHIFT_TIME_RE)!;
  const target = new Date(entryAt);
  target.setHours(Number(endHh), Number(endMm), 0, 0);

  const start = worker.shiftStart;
  const overnight =
    !!start && SHIFT_TIME_RE.test(start) && compareHHMM(end, start) < 0;

  if (overnight || target.getTime() <= entryAt.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function compareHHMM(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Para cada ENTRY GRANTED sem EXIT posterior, registra um EXIT automático
 * no instante de término do turno (ou ENTRY + 8h, no fallback).
 * Útil quando o porteiro esquece de registrar a saída.
 */
export async function runAutoExitOnce(now: Date = new Date()): Promise<number> {
  // Lookback amplo: cobre turnos noturnos e fallback. 36h dá margem de sobra
  // para turnos cuja saída prevista é no dia seguinte.
  const lookbackCutoff = new Date(now.getTime() - 36 * 60 * 60 * 1000);

  const candidates = await prisma.accessLog.findMany({
    where: {
      direction: AccessDirection.ENTRY,
      result: AccessResult.GRANTED,
      occurredAt: { gte: lookbackCutoff, lte: now },
      workerId: { not: null },
    },
    select: {
      id: true,
      companyId: true,
      workerId: true,
      occurredAt: true,
      gate: true,
      worker: { select: { shiftStart: true, shiftEnd: true } },
    },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });

  let inserted = 0;

  for (const entry of candidates) {
    if (!entry.workerId || !entry.worker) continue;

    const exitAt = autoExitInstant(entry.occurredAt, entry.worker);
    // Ainda não chegou a hora do auto-exit para esta entrada.
    if (exitAt.getTime() > now.getTime()) continue;

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

    const reason = entry.worker.shiftEnd
      ? `Saída automática no fim do turno (${entry.worker.shiftEnd}).`
      : "Saída automática após 8h sem registro manual";

    await prisma.accessLog.create({
      data: {
        companyId: entry.companyId,
        workerId: entry.workerId,
        direction: AccessDirection.EXIT,
        result: AccessResult.GRANTED,
        gate: entry.gate,
        qrHash: null,
        operatorId: null,
        occurredAt: exitAt,
        reason,
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
