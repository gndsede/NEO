import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./setup.js";
import { prisma } from "../src/lib/prisma.js";

const TEST_EMAIL = `regression-test-login-fail@example.com`;

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { actorEmail: TEST_EMAIL } });
  // O 401 forçado abaixo também é persistido em ErrorLog pelo errorHandler —
  // limpa o ruído de teste do painel de observabilidade.
  await prisma.errorLog.deleteMany({ where: { path: "/api/auth/login", statusCode: 401 } });
});

describe("auth — login (fluxo crítico)", () => {
  it("credenciais inválidas retornam 401 genérico e registram auditoria", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: "senha-errada-qualquer" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Credenciais inválidas");
    expect(res.body.requestId).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { actorEmail: TEST_EMAIL, action: "LOGIN_FAILED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });
});
