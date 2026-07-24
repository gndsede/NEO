/** Registro leve do estado dos schedulers em background (setInterval). */

interface SchedulerState {
  registeredAt: string;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastOk?: boolean;
  lastError?: string;
  runCount: number;
}

const schedulers = new Map<string, SchedulerState>();

export function registerScheduler(name: string): void {
  schedulers.set(name, { registeredAt: new Date().toISOString(), runCount: 0 });
}

export function recordSchedulerRun(
  name: string,
  result: { ok: boolean; durationMs: number; error?: string },
): void {
  const state = schedulers.get(name) ?? {
    registeredAt: new Date().toISOString(),
    runCount: 0,
  };
  state.lastRunAt = new Date().toISOString();
  state.lastDurationMs = result.durationMs;
  state.lastOk = result.ok;
  state.lastError = result.error;
  state.runCount++;
  schedulers.set(name, state);
}

/** Envolve o tick de um scheduler, medindo duração e capturando erros. */
export async function withSchedulerTracking(
  name: string,
  tick: () => Promise<void>,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  try {
    await tick();
    recordSchedulerRun(name, {
      ok: true,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    });
  } catch (err) {
    recordSchedulerRun(name, {
      ok: false,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function getSchedulerHealth(): Record<string, SchedulerState> {
  return Object.fromEntries(schedulers);
}
