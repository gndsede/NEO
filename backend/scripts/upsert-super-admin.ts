import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Credenciais SEMPRE via variáveis de ambiente — nunca hardcoded.
  // Uso: SA_EMAIL=... SA_PASSWORD=... npx tsx scripts/upsert-super-admin.ts
  const email = process.env.SA_EMAIL;
  const password = process.env.SA_PASSWORD;

  if (!email || !password) {
    console.error("❌ Defina SA_EMAIL e SA_PASSWORD no ambiente antes de rodar.");
    console.error('   Ex.: $env:SA_EMAIL="voce@neociv.com.br"; $env:SA_PASSWORD="..."; npx tsx scripts/upsert-super-admin.ts');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("❌ SA_PASSWORD deve ter ao menos 12 caracteres.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.superAdmin.upsert({
    where: { email },
    update: { passwordHash },
    create: {
      email,
      passwordHash,
      name: process.env.SA_NAME ?? "NEO Admin",
    },
  });

  console.log("✅ Super-admin pronto:", { email: admin.email, id: admin.id });
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
