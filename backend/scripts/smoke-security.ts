/**
 * Smoke test das correções de segurança. Cria um usuário temporário com 2FA,
 * exercita o fluxo HTTP real e remove o usuário ao final.
 * Uso único: npx tsx scripts/smoke-security.ts (API deve estar rodando).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { ALL_PERMISSION_KEYS } from "../src/lib/permissions.js";

const API = "http://localhost:3333/api";
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const results: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const email = `smoke-${Date.now()}@teste.local`;
  const password = randomBytes(12).toString("hex");
  const totpSecret = authenticator.generateSecret();

  const company = await prisma.company.findFirst({ select: { id: true } });
  if (!company) throw new Error("Nenhuma company no banco");
  const obra = await prisma.obra.findFirst({
    where: { companyId: company.id, active: true },
    select: { id: true },
  });
  if (!obra) throw new Error("Nenhuma obra ativa");

  const user = await prisma.user.create({
    data: {
      companyId: company.id,
      name: "Smoke Test",
      email,
      passwordHash: await bcrypt.hash(password, 10),
      profile: "USER",
      permissions: [...ALL_PERMISSION_KEYS],
      active: true,
      totpSecret,
      totpEnabled: true,
      obraAccess: { create: { obraId: obra.id } },
    },
  });

  try {
    // 1. Login → deve pedir 2FA
    const loginRes = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const login = (await loginRes.json()) as {
      requires2FA?: boolean;
      preAuthToken?: string;
    };
    check("Login exige 2FA", login.requires2FA === true && !!login.preAuthToken);

    // 2. Token pré-2FA NÃO pode ser usado como sessão (audience)
    const preAuthAsSession = await fetch(`${API}/workers`, {
      headers: { Authorization: `Bearer ${login.preAuthToken}` },
    });
    check(
      "Token pré-2FA rejeitado como sessão",
      preAuthAsSession.status === 401,
      `status ${preAuthAsSession.status}`,
    );

    // 3. Completa o 2FA e obtém sessão real
    const code = authenticator.generate(totpSecret);
    const twoFaRes = await fetch(`${API}/auth/login/2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preAuthToken: login.preAuthToken, code }),
    });
    const session = (await twoFaRes.json()) as { token?: string };
    check("2FA completa o login", twoFaRes.status === 200 && !!session.token);

    const auth = { Authorization: `Bearer ${session.token}` };

    // 4. Lista de workers com CPF decriptado (11 dígitos) e foto assinada
    const workersRes = await fetch(`${API}/workers?page=1&pageSize=5`, { headers: auth });
    const workers = (await workersRes.json()) as {
      items?: Array<{ cpf: string; photoUrl: string | null }>;
    };
    const first = workers.items?.[0];
    const cpfDigits = first ? first.cpf.replace(/\D/g, "") : "";
    check(
      "CPF retorna decriptado na API",
      !!first && cpfDigits.length === 11,
      first ? `cpf len=${cpfDigits.length}` : "sem workers",
    );
    const withPhoto = workers.items?.find((w) => w.photoUrl);
    if (withPhoto) {
      check(
        "URL de foto vem assinada (sig=)",
        withPhoto.photoUrl!.includes("sig="),
        withPhoto.photoUrl!.split("?")[0]!.slice(-30),
      );

      // 5. Arquivo COM assinatura → 200; SEM assinatura → 401
      const signed = await fetch(withPhoto.photoUrl!);
      check("Arquivo com assinatura acessível", signed.status === 200, `status ${signed.status}`);
      const unsigned = await fetch(withPhoto.photoUrl!.split("?")[0]!);
      check("Arquivo sem assinatura bloqueado", unsigned.status === 401, `status ${unsigned.status}`);
    }

    // 6. Endpoint público segue funcionando (com rate limit ativo)
    const pub = await fetch(`${API}/public/access-tokens/NEO-0A0AA0`);
    check("Endpoint público responde", pub.status === 200, `status ${pub.status}`);

    // 7. Mobile-login sem 2FA configurado → pede enrolamento (não bloqueia)
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecret: null },
    });
    const mobile = await fetch(`${API}/auth/mobile-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const mobileBody = (await mobile.json()) as { requires2FASetup?: boolean };
    check(
      "Mobile-login sem 2FA pede enrolamento",
      mobile.status === 200 && mobileBody.requires2FASetup === true,
      `status ${mobile.status}`,
    );

    // 8. Usuário desativado perde a sessão imediatamente
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    const afterDeactivate = await fetch(`${API}/workers`, { headers: auth });
    check(
      "Sessão de usuário desativado é derrubada",
      afterDeactivate.status === 401,
      `status ${afterDeactivate.status}`,
    );
  } finally {
    await prisma.userObraAccess.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    console.log("🧹 Usuário de teste removido.");
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações passaram.`);
  if (failed.length > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("Erro no smoke test:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
