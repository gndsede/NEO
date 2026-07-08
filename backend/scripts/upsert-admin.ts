import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const ALL_PERMISSIONS = [
  "dashboard.view",
  "obras.view", "obras.manage",
  "registros.view", "registros.manage",
  "tipos.view", "tipos.manage",
  "documentos.view", "documentos.attach", "documentos.approve", "documentos.mark_na",
  "colaboradores.view", "colaboradores.manage",
  "fornecedores.view", "fornecedores.manage",
  "cracha.view", "cracha.generate",
  "catraca.view", "catraca.manage",
  "usuarios.view", "usuarios.manage",
  "rdo.manage", "rdo.approve",
];

async function main() {
  // Garante que existe pelo menos uma company
  let company = await prisma.company.findFirst({ select: { id: true, name: true } });
  if (!company) {
    company = await prisma.company.create({
      data: {
        name: "Neo Soluções Civis",
        legalName: "Neo Soluções Civis LTDA",
        document: "12345678000199",
      },
      select: { id: true, name: true },
    });
    console.log("Company criada:", company.name);
  }

  // Credenciais SEMPRE via variáveis de ambiente — nunca hardcoded.
  // Uso: ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/upsert-admin.ts
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("❌ Defina ADMIN_EMAIL e ADMIN_PASSWORD no ambiente antes de rodar.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("❌ ADMIN_PASSWORD deve ter ao menos 8 caracteres.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, permissions: ALL_PERMISSIONS, active: true },
    create: {
      companyId: company.id,
      name: "Administrador",
      email,
      passwordHash,
      profile: "USER",
      permissions: ALL_PERMISSIONS,
      active: true,
    },
  });

  console.log("✅ Usuário pronto:", { email: user.email, companyId: user.companyId });
}

main()
  .catch((e) => { console.error("❌", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
