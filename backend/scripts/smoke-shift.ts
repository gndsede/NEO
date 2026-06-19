// Smoke test do cálculo de saída automática por turno.
// Não é teste unitário formal — só um sanity check rápido para o spot-check
// do hardening de auto-exit. Rode com: npx tsx scripts/smoke-shift.ts
import { autoExitInstant } from "../src/modules/access/access.auto-exit.js";

let pass = 0;
let fail = 0;

function check(name: string, expectedIso: string, actual: Date) {
  const ok = actual.toISOString() === expectedIso;
  if (ok) {
    pass++;
    console.log(`  ✓ ${name} → ${actual.toISOString()}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${name}\n      esperava ${expectedIso}\n      veio     ${actual.toISOString()}`,
    );
  }
}

console.log("=== Turno diurno: ENTRY 07:50, shift 08:00-17:00 ===");
check(
  "EXIT às 17:00 do mesmo dia (UTC-3)",
  "2026-06-17T20:00:00.000Z",
  autoExitInstant(new Date("2026-06-17T07:50:00-03:00"), {
    shiftStart: "08:00",
    shiftEnd: "17:00",
  }),
);

console.log("\n=== Turno noturno: ENTRY 22:30, shift 22:00-06:00 ===");
check(
  "EXIT às 06:00 do dia seguinte (UTC-3)",
  "2026-06-18T09:00:00.000Z",
  autoExitInstant(new Date("2026-06-17T22:30:00-03:00"), {
    shiftStart: "22:00",
    shiftEnd: "06:00",
  }),
);

console.log("\n=== Sem turno cadastrado: fallback ENTRY + 8h ===");
const entry = new Date("2026-06-17T10:00:00-03:00");
const expected = new Date(entry.getTime() + 8 * 3600 * 1000);
check(
  "EXIT 8h depois (fallback)",
  expected.toISOString(),
  autoExitInstant(entry, { shiftStart: null, shiftEnd: null }),
);

console.log("\n=== ENTRY após o término do turno (turno encerrado): ===");
// ENTRY 18:00, shift 08:00-17:00 → 17:00 do mesmo dia já passou, rola pro dia seguinte.
check(
  "EXIT no dia seguinte às 17:00",
  "2026-06-18T20:00:00.000Z",
  autoExitInstant(new Date("2026-06-17T18:00:00-03:00"), {
    shiftStart: "08:00",
    shiftEnd: "17:00",
  }),
);

console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
process.exit(fail > 0 ? 1 : 0);
