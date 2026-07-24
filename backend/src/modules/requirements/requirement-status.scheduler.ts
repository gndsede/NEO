import { recomputeStaleStatuses } from "./requirement-status.js";
import { logger } from "../../lib/logger.js";
import {
  registerScheduler,
  withSchedulerTracking,
} from "../../lib/scheduler-health.js";

// A cada 6h reavalia vencimentos (VIGENTE → PROX_VENCIMENTO → VENCIDO).
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SCHEDULER_NAME = "requirement-status";
registerScheduler(SCHEDULER_NAME);

let intervalRef: ReturnType<typeof setInterval> | null = null;

export function startRequirementStatusScheduler(): void {
  if (intervalRef) return;

  const tick = async () => {
    try {
      await withSchedulerTracking(SCHEDULER_NAME, async () => {
        const changed = await recomputeStaleStatuses();
        if (changed > 0) {
          logger.info("requirement_status_recomputed", { changed });
        }
      });
    } catch (e) {
      logger.error("requirement_status_tick_failed", { err: e });
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
