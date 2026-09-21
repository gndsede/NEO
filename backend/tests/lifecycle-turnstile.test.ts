import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { LifecyclePhase } from "@prisma/client";
import { app } from "./setup.js";
import { prisma } from "../src/lib/prisma.js";
import { signUserToken } from "../src/middleware/auth.js";
import { generateNeoAccessToken } from "../src/utils/access-hash.js";

/**
 * Efeito da fase documental na catraca.
 *
 * Entrada barra: a documentação admissional é o que autoriza o primeiro acesso.
 * Processo demissional libera: quem está cumprindo aviso continua trabalhando,
 * e a documentação de saída é condição para INATIVAR, não para entrar.
 */

const MARK = `turnstile-test-${Date.now()}`;
const PERMISSIONS = ["catraca.manage"];

let companyId: string;
let obraId: string;
let contractorId: string;
let token: string;

/** Cria colaborador + vínculo na fase pedida, com uma cobrança pendente nessa fase. */
async function createWorkerInPhase(suffix: string, phase: LifecyclePhase) {
  const qrHash = generateNeoAccessToken();
  const worker = await prisma.worker.create({
    data: {
      companyId,
      fullName: `${MARK}-${suffix}`,
      cpf: `${MARK}-cpf-${suffix}`,
      cpfHash: `${MARK}-hash-${suffix}`,
      qrHash,
    },
  });
  const assignment = await prisma.workerAssignment.create({
    data: {
      companyId,
      workerId: worker.id,
      obraId,
      contractorId,
      role: "Pedreiro",
      phase,
    },
  });
  await prisma.workerRequirementItem.create({
    data: {
      companyId,
      workerId: worker.id,
      assignmentId: assignment.id,
      source: "MANUAL",
      status: "NOT_SENT",
      name: `${MARK}-cobranca-${suffix}`,
      documentType: "STANDARD",
      frequency: "ONE_TIME",
      phase,
    },
  });
  return { worker, assignment, qrHash };
}

function scan(qr: string) {
  return request(app)
    .post("/api/access/scan")
    .set("Authorization", `Bearer ${token}`)
    .set("x-obra-id", obraId)
    .send({ qr, direction: "ENTRY" });
}

beforeAll(async () => {
  const company = await prisma.company.create({ data: { name: `${MARK}-company` } });
  companyId = company.id;

  const obra = await prisma.obra.create({ data: { companyId, name: `${MARK}-obra` } });
  obraId = obra.id;

  const contractor = await prisma.contractor.create({
    data: { companyId, obraId, name: `${MARK}-contractor` },
  });
  contractorId = contractor.id;

  const user = await prisma.user.create({
    data: {
      companyId,
      name: `${MARK}-porteiro`,
      email: `${MARK}@example.com`,
      passwordHash: "unused-in-this-test",
      active: true,
      allObrasAccess: true,
      permissions: PERMISSIONS,
    },
  });

  token = signUserToken({
    id: user.id,
    companyId,
    profile: "USER",
    email: user.email,
    permissions: PERMISSIONS,
    contractorId: null,
    obraIds: [obraId],
    activeObraId: obraId,
    allObrasAccess: true,
    allowedDocumentTypes: null,
  });
});

afterAll(async () => {
  await prisma.accessLog.deleteMany({ where: { companyId } });
  await prisma.workerRequirementItem.deleteMany({ where: { companyId } });
  await prisma.workerAssignment.deleteMany({ where: { companyId } });
  await prisma.worker.deleteMany({ where: { companyId } });
  await prisma.contractor.deleteMany({ where: { companyId } });
  await prisma.obra.deleteMany({ where: { companyId } });
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
});

describe("catraca × fase documental", () => {
  it("nega acesso a quem ainda está em processo de entrada", async () => {
    const { qrHash } = await createWorkerInPhase("entrada", LifecyclePhase.ENTRADA);
    const res = await scan(qrHash);

    expect(res.status).toBe(403);
    expect(res.body.result).toBe("DENIED");
    expect(res.body.reason).toMatch(/processo de entrada/i);
  });

  it("libera quem está em processo demissional, mesmo com documentação de saída pendente", async () => {
    const { qrHash } = await createWorkerInPhase("saida", LifecyclePhase.SAIDA);
    const res = await scan(qrHash);

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("GRANTED");
  });

  it("mantém o bloqueio por pendência de documentação de atividade", async () => {
    const { qrHash } = await createWorkerInPhase("atividade", LifecyclePhase.ATIVIDADE);
    const res = await scan(qrHash);

    expect(res.status).toBe(403);
    expect(res.body.result).toBe("DENIED");
    expect(res.body.pendingRequirements).toHaveLength(1);
  });
});
