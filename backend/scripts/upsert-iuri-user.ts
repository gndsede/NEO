import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

async function main() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 300_000,
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const email = "iuri.mariano@gndconstrucoes.com.br";
    const passwordHash = await bcrypt.hash("1803", 10);

    const company = await prisma.company.findFirst({
      select: { id: true },
    });

    if (!company) {
      throw new Error("Nenhuma company encontrada. Execute o seed primeiro.");
    }

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        name: "Iuri Mariano",
        passwordHash,
        active: true,
        role: "OWNER",
        companyId: company.id,
      },
      create: {
        companyId: company.id,
        name: "Iuri Mariano",
        email,
        passwordHash,
        role: "OWNER",
        active: true,
      },
    });

    // eslint-disable-next-line no-console
    console.log("USER_READY", { email: user.email, companyId: user.companyId });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
