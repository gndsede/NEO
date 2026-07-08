import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { apiRouter } from "./routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import { signFileUrlsDeep, verifyFileSignature } from "./lib/file-signing.js";

export function createApp() {
  const app = express();

  const isDev = env.NODE_ENV === "development";
  const allowedOrigins =
    env.CORS_ORIGIN === "*"
      ? []
      : env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

  // Necessário atrás de reverse proxy (nginx, load balancer) para que o
  // rate limit enxergue o IP real do cliente e não o do proxy.
  if (env.TRUST_PROXY > 0) {
    app.set("trust proxy", env.TRUST_PROXY);
  }

  if (!isDev && env.CORS_ORIGIN === "*") {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  CORS_ORIGIN='*' em produção. Configure a(s) origem(ns) do frontend (ex.: https://app.suaempresa.com.br).",
    );
  }

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
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

  // Storage local: arquivos exigem URL assinada (sig + exp) gerada pela API.
  // Sem assinatura válida, fotos e documentos não são servidos.
  if (env.STORAGE_DRIVER === "local") {
    const uploadsDir = path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
    app.use(
      "/files",
      (req, res, next) => {
        const exp = Number(req.query.exp);
        const sig = String(req.query.sig ?? "");
        const key = decodeURIComponent(req.path.replace(/^\//, ""));
        if (!verifyFileSignature(key, exp, sig)) {
          res.status(401).json({ error: "URL de arquivo inválida ou expirada" });
          return;
        }
        next();
      },
      express.static(uploadsDir),
    );

    // Assina automaticamente URLs /files presentes em qualquer resposta JSON
    // da API, para que o frontend receba links prontos e temporários.
    app.use("/api", (_req, res, next) => {
      const original = res.json.bind(res);
      res.json = ((body: unknown) =>
        original(signFileUrlsDeep(body))) as typeof res.json;
      next();
    });
  }

  app.use("/api", apiRateLimit, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
