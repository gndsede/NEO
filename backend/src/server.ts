import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import {
  startAutoExitScheduler,
  stopAutoExitScheduler,
} from "./modules/access/access.auto-exit.js";
import {
  startRequirementStatusScheduler,
  stopRequirementStatusScheduler,
} from "./modules/requirements/requirement-status.scheduler.js";
import {
  startNotificationScheduler,
  stopNotificationScheduler,
} from "./modules/notifications/notification.scheduler.js";

async function bootstrap() {
  const app = createApp();

  const server = app.listen(env.PORT, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(
      `🚀 AccessHub API rodando em http://localhost:${env.PORT} (${env.NODE_ENV})`,
    );
    // eslint-disable-next-line no-console
    console.log(`   Rede local: aceita conexões em 0.0.0.0:${env.PORT}`);
  });

  startAutoExitScheduler();
  startRequirementStatusScheduler();
  startNotificationScheduler();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} recebido. Encerrando...`);
    stopAutoExitScheduler();
    stopRequirementStatusScheduler();
    stopNotificationScheduler();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Falha no boot da aplicação:", err);
  process.exit(1);
});
