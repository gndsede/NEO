/**
 * Script de migração LGPD — Criptografia de Campos PII
 *
 * Executa UMA VEZ para criptografar CPF e RG de todos os Workers existentes
 * e recomputar cpfHash como HMAC-SHA256 (em vez de SHA256 simples da migração SQL).
 *
 * Pré-requisito: ENCRYPTION_KEY definida no .env (string hex de 64 chars).
 *
 * Uso:
 *   npx tsx scripts/encrypt-pii.ts
 *   # ou em produção:
 *   node --import tsx/esm scripts/encrypt-pii.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encrypt, hashCpf } from "../src/lib/crypto.js";
import { env } from "../src/config/env.js";

if (!env.ENCRYPTION_KEY) {
  console.error("❌  ENCRYPTION_KEY não configurada. Defina no .env antes de rodar este script.");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
const BATCH = 100;

async function main() {
  console.log("🔐 Iniciando criptografia de campos PII dos colaboradores...");

  let offset = 0;
  let total = 0;

  for (;;) {
    const workers = await prisma.worker.findMany({
      select: { id: true, cpf: true, rg: true, anonymizedAt: true },
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: BATCH,
    });

    if (workers.length === 0) break;

    for (const w of workers) {
      // Pula workers já anonimizados
      if (w.anonymizedAt) continue;

      // Detecta se cpf já está criptografado (base64 com IV+TAG+data)
      const isCpfPlain = !isEncrypted(w.cpf);
      const isRgPlain = w.rg ? !isEncrypted(w.rg) : false;

      if (!isCpfPlain && !isRgPlain) continue; // Já criptografado, pula

      await prisma.worker.update({
        where: { id: w.id },
        data: {
          ...(isCpfPlain
            ? {
                cpf: encrypt(w.cpf),
                cpfHash: hashCpf(w.cpf), // Recomputa como HMAC
              }
            : {}),
          ...(isRgPlain && w.rg ? { rg: encrypt(w.rg) } : {}),
        },
      });
      total += 1;
    }

    offset += workers.length;
    process.stdout.write(`  Processados ${offset} workers (${total} criptografados)...\r`);
  }

  console.log(`\n✅ Concluído. ${total} workers tiveram dados criptografados.`);
}

/**
 * Heurística: um campo criptografado é base64 de pelo menos 29 bytes
 * (12 IV + 16 TAG + 1+ data) e não contém dígitos CPF/RG simples.
 */
function isEncrypted(value: string): boolean {
  try {
    const buf = Buffer.from(value, "base64");
    return buf.length >= 29 && !value.match(/^\d+$/);
  } catch {
    return false;
  }
}

main()
  .catch((e) => {
    console.error("❌ Erro durante migração:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
