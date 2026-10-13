import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./setup.js";
import { prisma } from "../src/lib/prisma.js";
import { signUserToken } from "../src/middleware/auth.js";

/**
 * Permissões por grupo: o usuário recebe as permissões dos grupos ATIVOS
 * dos quais é membro (somadas às individuais), lidas do banco a cada
 * requisição — não do JWT. E criar usuário exige ao menos um grupo.
 */

const MARK = `group-perm-test-${Date.now()}`;

let companyId: string;
let groupId: string;
let adminToken: string;
let memberToken: string;

function tokenFor(user: { id: string; email: string }) {
  return signUserToken({
    id: user.id,
    companyId,
    profile: "USER",
    email: user.email,
    // Sem permissões no JWT de propósito: devem vir do banco.
    permissions: [],
    contractorId: null,
    obraIds: [],
    activeObraId: null,
    allObrasAccess: true,
    allowedDocumentTypes: null,
  });
}

beforeAll(async () => {
  const company = await prisma.company.create({ data: { name: `${MARK}-company` } });
  companyId = company.id;

  const group = await prisma.userGroup.create({
    data: { companyId, name: `${MARK}-grupo`, permissions: ["usuarios.view", "rdo.view"] },
  });
  groupId = group.id;

  const admin = await prisma.user.create({
    data: {
      companyId,
      name: `${MARK}-admin`,
      email: `${MARK}-admin@example.com`,
      passwordHash: "unused-in-this-test",
      allObrasAccess: true,
      permissions: ["usuarios.manage"],
    },
  });
  adminToken = tokenFor(admin);

  const member = await prisma.user.create({
    data: {
      companyId,
      name: `${MARK}-member`,
      email: `${MARK}-member@example.com`,
      passwordHash: "unused-in-this-test",
      allObrasAccess: true,
      permissions: ["catraca.view"],
      groupMemberships: { create: { groupId } },
    },
  });
  memberToken = tokenFor(member);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { companyId } });
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.userGroup.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
});

describe("permissões por grupo", () => {
  it("soma permissões do grupo às individuais", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.permissions).toEqual(
      expect.arrayContaining(["catraca.view", "usuarios.view", "rdo.view"]),
    );
  });

  it("grupo inativo deixa de conceder permissão, sem novo login", async () => {
    await prisma.userGroup.update({ where: { id: groupId }, data: { active: false } });
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
    await prisma.userGroup.update({ where: { id: groupId }, data: { active: true } });
  });

  it("criar usuário sem grupo é rejeitado", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Sem Grupo", email: `${MARK}-nogroup@example.com`, password: "senha-forte-123" });
    expect(res.status).toBe(400);
  });

  it("criar usuário com grupo vincula a associação", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Com Grupo",
        email: `${MARK}-withgroup@example.com`,
        password: "senha-forte-123",
        allObrasAccess: true,
        groupIds: [groupId],
      });
    expect(res.status).toBe(201);
    expect(res.body.groupIds).toEqual([groupId]);
  });
});
