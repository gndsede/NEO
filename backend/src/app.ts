import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { apiRouter } from "./routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export function createApp() {
  const app = express();

  const isDev = env.NODE_ENV === "development";
  const allowedOrigins =
    env.CORS_ORIGIN === "*"
      ? []
      : env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Em desenvolvimento, libera qualquer origem para evitar bloqueios
        // de porta dinâmica do Vite (8080, 8081, etc.).
        if (isDev || !origin || env.CORS_ORIGIN === "*") {
          callback(null, true);
          return;
        }

        callback(null, allowedOrigins.includes(origin));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

  // Servir arquivos do driver de storage local (apenas dev/standalone).
  if (env.STORAGE_DRIVER === "local") {
    const uploadsDir = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
    app.use("/files", express.static(uploadsDir));
  }

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
