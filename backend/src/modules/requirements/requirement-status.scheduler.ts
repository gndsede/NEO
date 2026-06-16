import { recomputeStaleStatuses } from "./requirement-status.js";

// A cada 6h reavalia vencimentos (VIGENTE → PROX_VENCIMENTO → VENCIDO).
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let intervalRef: ReturnType<typeof setInterval> | null = null;

export function startRequirementStatusScheduler(): void {
  if (intervalRef) return;

  const tick = async () => {
    try {
      const changed = await recomputeStaleStatuses();
      if (changed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[req-status] ${changed} exigência(s) reavaliada(s).`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[req-status] erro no tick:", e);
    }
  };

  // Backfill 20s após o boot (corrige itens existentes pós-migration) + a cada 6h.
  setTimeout(() => void tick(), 20_000);
  intervalRef = setInterval(() => void tick(), CHECK_INTERVAL_MS);
}

export function stopRequirementStatusScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
  }
}
