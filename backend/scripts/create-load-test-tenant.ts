/**
 * Cria (ou reaproveita) um tenant isolado só para o teste de carga do
 * load-tests/load-test.js — nunca toca dados de empresas/usuários reais.
 *
 * Por padrão roda contra o DATABASE_URL do backend/.env (banco local de dev).
 * Para rodar contra produção, informe a connection string do Railway na hora
 * de chamar o script — ela NUNCA fica salva em nenhum arquivo do projeto:
 *
 *   (bash)       DATABASE_URL="postgresql://...railway..." npx tsx scripts/create-load-test-tenant.ts
 *   (PowerShell) $env:DATABASE_URL="postgresql://...railway..."; npx tsx scripts/create-load-test-tenant.ts
 *
 * Rode a partir da pasta backend/. Gera load-tests/test-users.json e
 * load-tests/test-config.json (ambos ignorados pelo git).
 *
 * Para remover o tenant de teste depois: apague a linha em "companies" com o
 * nome abaixo — o ON DELETE CASCADE do schema cuida do resto.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { fullPermissions } from "../src/lib/permissions.js";
import { generateWorkerQrHash } from "../src/utils/access-hash.js";

const COMPANY_NAME = "NEO — Tenant de Teste (Carga)";
const NUM_USERS = 3;
const LOAD_TESTS_DIR = path.resolve(import.meta.dirname, "../../load-tests");

function randomBase32Secret(bytes = 20): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const buf = randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

async function main() {
  let company = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  if (!company) {
    company = await prisma.company.create({
      data: { name: COMPANY_NAME, plan: "ENTERPRISE", active: true },
    });
    console.log(`Empresa de teste criada: ${company.id}`);
  } else {
    console.log(`Empresa de teste já existia, reaproveitando: ${company.id}`);
  }

  let obra = await prisma.obra.findFirst({ where: { companyId: company.id } });
  if (!obra) {
    obra = await prisma.obra.create({
      data: { companyId: company.id, name: "Obra de Teste (Carga)", active: true },
    });
  }

  const permissions = fullPermissions() as unknown as Prisma.InputJsonValue;
  const testUsers: { email: string; password: string; totpSecret: string }[] = [];

  for (let i = 1; i <= NUM_USERS; i++) {
    const email = `loadtest${i}@neosolucoescivis.com.br`;
    const password = `LoadTest#${randomBytes(6).toString("hex")}`;
    const totpSecret = randomBase32Secret();
    const passwordHash = await hashPassword(password);

    await prisma.user.upsert({
      where: { email },
      create: {
        companyId: company.id,
        name: `Load Test ${i}`,
        email,
        passwordHash,
        active: true,
        allObrasAccess: true,
        permissions,
        totpEnabled: true,
        totpSecret,
      },
      update: {
        passwordHash,
        active: true,
        allObrasAccess: true,
        permissions,
        totpEnabled: true,
        totpSecret,
      },
    });

    testUsers.push({ email, password, totpSecret });
    console.log(`Usuário de teste pronto: ${email}`);
  }

  let worker = await prisma.worker.findFirst({ where: { companyId: company.id } });
  if (!worker) {
    worker = await prisma.worker.create({
      data: {
        companyId: company.id,
        fullName: "Colaborador de Teste (Carga)",
        cpf: "00000000000",
        cpfHash: `loadtest-${company.id}`,
        qrHash: generateWorkerQrHash(),
      },
    });
  }

  writeFileSync(
    path.join(LOAD_TESTS_DIR, "test-users.json"),
    JSON.stringify(testUsers, null, 2),
  );
  writeFileSync(
    path.join(LOAD_TESTS_DIR, "test-config.json"),
    JSON.stringify({ companyId: company.id, obraId: obra.id, workerQr: worker.qrHash }, null, 2),
  );

  console.log("\nGravado: load-tests/test-users.json e load-tests/test-config.json");
  console.log(`Empresa: ${company.id} · Obra: ${obra.id} · QR do colaborador: ${worker.qrHash}`);
  console.log(
    `\nPara remover depois: DELETE FROM companies WHERE name = '${COMPANY_NAME}';`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
