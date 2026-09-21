import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "../src/lib/password.js";

/**
 * Reset de autenticação em massa — recuperação de acesso.
 *
 * Nenhum usuário é escrito no código: o script opera sobre TODAS as linhas
 * existentes em `super_admins` e `users`, e a senha nova (quando pedida) vem
 * sempre de variável de ambiente.
 *
 * O que faz:
 *   - 2FA: limpa `totpSecret`, marca `totpEnabled = false` e descarta os códigos
 *     de backup. No próximo login o próprio fluxo gera um QR Code novo
 *     (o enrolamento acontece em POST /auth/login e /super-admin/auth/login).
 *   - Senha (opcional): só quando `--senha` é passado, lendo RESET_PASSWORD.
 *
 * Uso:
 *   npx tsx scripts/reset-auth.ts                      # dry-run (não grava nada)
 *   npx tsx scripts/reset-auth.ts --yes                # aplica: zera o 2FA de todos
 *   $env:RESET_PASSWORD="..."; npx tsx scripts/reset-auth.ts --yes --senha
 *   npx tsx scripts/reset-auth.ts --yes --escopo=sa    # só os super-admins
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const args = process.argv.slice(2);
const apply = args.includes("--yes");
const resetPassword = args.includes("--senha");
const scopeArg = args.find((a) => a.startsWith("--escopo="))?.split("=")[1] ?? "all";

const MIN_PASSWORD_LENGTH = 12;

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

async function main() {
  if (!["all", "sa", "users"].includes(scopeArg)) {
    console.error(`❌ --escopo inválido: "${scopeArg}". Use all, sa ou users.`);
    process.exit(1);
  }

  const touchSa = scopeArg === "all" || scopeArg === "sa";
  const touchUsers = scopeArg === "all" || scopeArg === "users";

  let plainPassword: string | null = null;
  if (resetPassword) {
    const password = process.env.RESET_PASSWORD;
    if (!password) {
      console.error("❌ --senha exige a variável RESET_PASSWORD definida no ambiente.");
      console.error('   Ex.: $env:RESET_PASSWORD="..."; npx tsx scripts/reset-auth.ts --yes --senha');
      process.exit(1);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(`❌ RESET_PASSWORD deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      process.exit(1);
    }
    plainPassword = password;
  }

  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
  console.log(`Banco:  ${dbHost}`);
  console.log(`Escopo: ${scopeArg}`);
  console.log(`Ações:  2FA zerado${resetPassword ? " + senha redefinida" : " (senhas preservadas)"}`);
  console.log(apply ? "Modo:   APLICANDO\n" : "Modo:   DRY-RUN (nada será gravado — use --yes para aplicar)\n");

  const admins = touchSa
    ? await prisma.superAdmin.findMany({ select: { id: true, email: true, totpEnabled: true } })
    : [];
  const users = touchUsers
    ? await prisma.user.findMany({ select: { id: true, email: true, totpEnabled: true, active: true } })
    : [];

  if (touchSa) {
    console.log(`Super-admins alcançados: ${admins.length}`);
    for (const a of admins) console.log(`  - ${maskEmail(a.email)} (2FA ativo: ${a.totpEnabled})`);
  }
  if (touchUsers) {
    console.log(`Usuários alcançados: ${users.length}`);
    for (const u of users) console.log(`  - ${maskEmail(u.email)} (2FA ativo: ${u.totpEnabled}, ativo: ${u.active})`);
  }

  if (!apply) {
    console.log("\nDry-run encerrado. Nada foi alterado.");
    return;
  }

  const twoFactorReset = { totpSecret: null, totpEnabled: false };
  // Json nulo no Prisma exige DbNull (NULL no banco), não `null`.
  const userReset = { ...twoFactorReset, totpBackupCodes: Prisma.DbNull };

  // bcrypt custo 12 é lento de propósito: gera os hashes ANTES de abrir a
  // transação, senão o timeout padrão (5s) estoura com poucos registros.
  // Um hash por registro para que cada senha tenha o próprio salt.
  const saHashes = new Map<string, string>();
  const userHashes = new Map<string, string>();
  if (plainPassword) {
    for (const a of admins) saHashes.set(a.id, await hashPassword(plainPassword));
    for (const u of users) userHashes.set(u.id, await hashPassword(plainPassword));
  }

  let saCount = 0;
  let userCount = 0;

  await prisma.$transaction(async (tx) => {
    if (touchSa) {
      if (plainPassword) {
        for (const a of admins) {
          await tx.superAdmin.update({
            where: { id: a.id },
            data: { ...twoFactorReset, passwordHash: saHashes.get(a.id)! },
          });
        }
        saCount = admins.length;
      } else {
        saCount = (await tx.superAdmin.updateMany({ data: twoFactorReset })).count;
      }
    }

    if (touchUsers) {
      if (plainPassword) {
        for (const u of users) {
          await tx.user.update({
            where: { id: u.id },
            data: { ...userReset, passwordHash: userHashes.get(u.id)! },
          });
        }
        userCount = users.length;
      } else {
        userCount = (await tx.user.updateMany({ data: userReset })).count;
      }
    }
  });

  console.log(`\n✅ Super-admins atualizados: ${saCount}`);
  console.log(`✅ Usuários atualizados: ${userCount}`);
  console.log("\nPróximo login gera um QR Code novo para cadastrar no autenticador.");
  if (resetPassword) {
    console.log("⚠️  Todos ficaram com a MESMA senha — troque cada uma após reentrar.");
  }
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
