import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./setup.js";
import { prisma } from "../src/lib/prisma.js";
import { signUserToken } from "../src/middleware/auth.js";

/**
 * Testes negativos de autorização (auditoria P1-1 e P1-2): um usuário
 * restrito a uma obra não pode aprovar/rejeitar documentos nem exportar
 * RDOs de OUTRA obra da mesma empresa, mesmo conhecendo o ID do recurso.
 * Antes da correção, `getOwnedDocument` (documents) e o filtro de
 * `GET /rdo/export/pdf` só checavam `companyId`, ignorando a obra.
 */

const MARK = `bola-test-${Date.now()}`;

let companyId: string;
let obraAId: string;
let obraBId: string;
let restrictedUserId: string;
let restrictedToken: string;
let contractorBId: string;
let documentInObraBId: string;
let workerDocumentInObraBId: string;
let rdoInObraBId: string;

beforeAll(async () => {
  const company = await prisma.company.create({
    data: { name: `${MARK}-company` },
  });
  companyId = company.id;

  const obraA = await prisma.obra.create({
    data: { companyId, name: `${MARK}-obra-a` },
  });
  const obraB = await prisma.obra.create({
    data: { companyId, name: `${MARK}-obra-b` },
  });
  obraAId = obraA.id;
  obraBId = obraB.id;

  const user = await prisma.user.create({
    data: {
      companyId,
      name: `${MARK}-user`,
      email: `${MARK}@example.com`,
      passwordHash: "unused-in-this-test",
      active: true,
      allObrasAccess: false,
      permissions: ["documentos.approve", "rdo.view"],
      totpEnabled: true,
    },
  });
  restrictedUserId = user.id;

  // Vincula o usuário SÓ à obra A — obra B fica fora do escopo dele.
  await prisma.userObraAccess.create({
    data: { userId: user.id, obraId: obraAId },
  });

  restrictedToken = signUserToken({
    id: user.id,
    companyId,
    profile: "USER",
    email: user.email,
    permissions: ["documentos.approve", "rdo.view"],
    contractorId: null,
    obraIds: [],
    activeObraId: null,
    allObrasAccess: false,
    allowedDocumentTypes: null,
  });

  const contractor = await prisma.contractor.create({
    data: { companyId, obraId: obraBId, name: `${MARK}-contractor` },
  });
  contractorBId = contractor.id;

  const doc = await prisma.document.create({
    data: {
      companyId,
      ownerType: "CONTRACTOR",
      contractorId: contractorBId,
      type: "STANDARD",
      fileUrl: "https://example.com/fake.pdf",
    },
  });
  documentInObraBId = doc.id;

  const rdo = await prisma.rdo.create({
    data: { companyId, obraId: obraBId, data: new Date() },
  });
  rdoInObraBId = rdo.id;

  const worker = await prisma.worker.create({
    data: {
      companyId,
      fullName: `${MARK}-worker`,
      cpf: `${MARK}-cpf`,
      cpfHash: `${MARK}-cpf-hash`,
      qrHash: `${MARK}-qr-hash`,
    },
  });

  await prisma.workerAssignment.create({
    data: {
      companyId,
      workerId: worker.id,
      obraId: obraBId,
      contractorId: contractorBId,
      role: "Pedreiro",
    },
  });

  const workerDoc = await prisma.document.create({
    data: {
      companyId,
      ownerType: "WORKER",
      workerId: worker.id,
      type: "STANDARD",
      fileUrl: "https://example.com/fake-worker-doc.pdf",
    },
  });
  workerDocumentInObraBId = workerDoc.id;
});

afterAll(async () => {
  await prisma.document.deleteMany({ where: { companyId } });
  await prisma.rdo.deleteMany({ where: { companyId } });
  await prisma.workerAssignment.deleteMany({ where: { companyId } });
  await prisma.worker.deleteMany({ where: { companyId } });
  await prisma.contractor.deleteMany({ where: { companyId } });
  await prisma.userObraAccess.deleteMany({ where: { userId: restrictedUserId } });
  await prisma.auditLog.deleteMany({ where: { companyId } });
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.obra.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
});

describe("autorização — escopo de obra (P1-1, P1-2)", () => {
  it("usuário restrito à obra A não aprova documento de obra B (404, não 200)", async () => {
    const res = await request(app)
      .patch(`/api/documents/${documentInObraBId}/approve`)
      .set("Authorization", `Bearer ${restrictedToken}`)
      .send({});

    expect(res.status).toBe(404);

    const doc = await prisma.document.findUnique({ where: { id: documentInObraBId } });
    expect(doc?.status).toBe("PENDENTE");
  });

  it("usuário restrito à obra A não rejeita documento de obra B (404, não 200)", async () => {
    const res = await request(app)
      .patch(`/api/documents/${documentInObraBId}/reject`)
      .set("Authorization", `Bearer ${restrictedToken}`)
      .send({ reason: "teste" });

    expect(res.status).toBe(404);
  });

  it("usuário restrito à obra A não aprova documento de COLABORADOR vinculado só à obra B (404, não 200)", async () => {
    const res = await request(app)
      .patch(`/api/documents/${workerDocumentInObraBId}/approve`)
      .set("Authorization", `Bearer ${restrictedToken}`)
      .send({});

    expect(res.status).toBe(404);

    const doc = await prisma.document.findUnique({ where: { id: workerDocumentInObraBId } });
    expect(doc?.status).toBe("PENDENTE");
  });

  it("usuário restrito à obra A não exporta RDO de obra B via ?ids=", async () => {
    const res = await request(app)
      .get(`/api/rdo/export/pdf?ids=${rdoInObraBId}`)
      .set("Authorization", `Bearer ${restrictedToken}`);

    // Fora do escopo → filtro não encontra nenhum RDO (mesmo comportamento
    // de "nenhum resultado para o período/ids"), nunca o PDF do outro tenant/obra.
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).not.toMatch(/application\/pdf/);
  });
});
