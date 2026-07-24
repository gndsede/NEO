import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./setup.js";
import { prisma } from "../src/lib/prisma.js";

const TEST_PATHS = [
  "/api/rota-que-nao-existe",
  "/api/auth/login",
  "/api/reports/compliance-overview",
  "/api/super-admin/observability/health",
];

// Os testes abaixo forçam erros reais (401/400/404) que o errorHandler
// persiste em ErrorLog — limpa o ruído gerado por este arquivo do painel.
afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { path: { in: TEST_PATHS } } });
});

describe("observabilidade — request id", () => {
  it("toda resposta carrega X-Request-Id", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("reaproveita X-Request-Id enviado pelo cliente", async () => {
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", "regression-test-fixed-id");
    expect(res.headers["x-request-id"]).toBe("regression-test-fixed-id");
  });
});

describe("observabilidade — envelope de erro", () => {
  it("404 inclui requestId no corpo", async () => {
    const res = await request(app).get("/api/rota-que-nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("requestId");
    expect(res.body.requestId).toBeTruthy();
  });

  it("erro de validação (400) inclui requestId e detalhes", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "não-é-email", password: "" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("requestId");
    expect(res.body).toHaveProperty("details");
  });
});

describe("observabilidade — rotas protegidas exigem autenticação", () => {
  it("rota de tenant sem token retorna 401", async () => {
    const res = await request(app).get("/api/reports/compliance-overview");
    expect(res.status).toBe(401);
  });

  it("rota de observabilidade (super-admin) sem token retorna 401", async () => {
    const res = await request(app).get("/api/super-admin/observability/health");
    expect(res.status).toBe(401);
  });
});
