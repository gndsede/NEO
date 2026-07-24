import "dotenv/config";
import { PrismaClient, DocumentOwnerType, DocumentType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { generateNeoAccessToken } from "../src/utils/access-hash.js";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  // Empresa contratante (tenant)
  const company = await prisma.company.upsert({
    where: { document: "12345678000199" },
    update: {},
    create: {
      name: "Neo Soluções Civis",
      legalName: "Neo Soluções Civis LTDA",
      document: "12345678000199",
      siteName: "Centro Empresarial — SP",
      city: "São Paulo",
      state: "SP",
    },
  });

  // Usuário admin de desenvolvimento — senha via env (SEED_ADMIN_PASSWORD).
  const seedPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!seedPassword || seedPassword.length < 8) {
    throw new Error(
      "Defina SEED_ADMIN_PASSWORD (mínimo 8 caracteres) no ambiente para rodar o seed.",
    );
  }
  const passwordHash = await bcrypt.hash(seedPassword, 10);
  const allPermissions = [
    "dashboard.view",
    "obras.view",
    "obras.manage",
    "registros.view",
    "registros.manage",
    "tipos.view",
    "tipos.manage",
    "documentos.view",
    "documentos.attach",
    "documentos.approve",
    "documentos.mark_na",
    "colaboradores.view",
    "colaboradores.manage",
    "fornecedores.view",
    "fornecedores.manage",
    "cracha.view",
    "cracha.generate",
    "catraca.view",
    "catraca.manage",
    "usuarios.view",
    "usuarios.manage",
  ];
  const admin = await prisma.user.upsert({
    where: { email: "admin@accesshub.dev" },
    update: { profile: "USER", permissions: allPermissions, allObrasAccess: true },
    create: {
      companyId: company.id,
      name: "Administrador",
      email: "admin@accesshub.dev",
      passwordHash,
      profile: "USER",
      permissions: allPermissions,
      allObrasAccess: true,
    },
  });

  const obra = await prisma.obra.upsert({
    where: { companyId_code: { companyId: company.id, code: "principal" } },
    update: {},
    create: {
      companyId: company.id,
      name: company.siteName ?? company.name,
      code: "principal",
      city: company.city ?? undefined,
      state: company.state ?? undefined,
    },
  });

  await prisma.userObraAccess.upsert({
    where: { userId_obraId: { userId: admin.id, obraId: obra.id } },
    update: {},
    create: { userId: admin.id, obraId: obra.id },
  });

  // Empreiteiras
  const alfa = await prisma.contractor.upsert({
    where: { obraId_cnpj: { obraId: obra.id, cnpj: "11222333000144" } },
    update: {},
    create: {
      companyId: company.id,
      obraId: obra.id,
      name: "Construtora Alfa",
      legalName: "Construtora Alfa LTDA",
      cnpj: "11222333000144",
      email: "contato@alfa.com.br",
    },
  });

  await prisma.contractor.upsert({
    where: { obraId_cnpj: { obraId: obra.id, cnpj: "55666777000122" } },
    update: {},
    create: {
      companyId: company.id,
      obraId: obra.id,
      name: "Beta Engenharia",
      legalName: "Beta Engenharia S.A.",
      cnpj: "55666777000122",
    },
  });

  // Colaborador de exemplo + documentos (PENDENTE)
  const worker = await prisma.worker.upsert({
    where: { obraId_cpf: { obraId: obra.id, cpf: "12345678901" } },
    update: {},
    create: {
      companyId: company.id,
      obraId: obra.id,
      contractorId: alfa.id,
      fullName: "João da Silva Pereira",
      cpf: "12345678901",
      rg: "12.345.678-9",
      role: "Pedreiro",
      registration: "CLB-00482",
      qrHash: generateNeoAccessToken(),
      documents: {
        create: [
          {
            companyId: company.id,
            ownerType: DocumentOwnerType.WORKER,
            type: DocumentType.ASO,
            title: "ASO admissional",
            fileUrl: "https://example.com/seed/aso.pdf",
            expiresAt: new Date("2026-12-31"),
          },
          {
            companyId: company.id,
            ownerType: DocumentOwnerType.WORKER,
            type: DocumentType.NR_35,
            title: "NR-35 Trabalho em Altura",
            fileUrl: "https://example.com/seed/nr35.pdf",
            expiresAt: new Date("2027-03-14"),
          },
        ],
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log("Seed concluído:", {
    company: company.name,
    admin: admin.email,
    contractor: alfa.name,
    worker: worker.fullName,
  });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
