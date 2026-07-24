import type { NextFunction, Request, Response } from "express";
import { getElapsedMs } from "./request-context.js";
import { logger } from "../lib/logger.js";
import { requestMetrics } from "../lib/metrics.js";

/**
 * Log de acesso estruturado (substitui o `morgan`) + alimenta as métricas de
 * performance por rota. Precisa rodar depois de `requestContext()` (usa
 * `getElapsedMs`) e depois do roteamento ter sido resolvido — a leitura só
 * acontece no evento `finish`, quando `req.route` já está preenchido.
 */
export function accessLog() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on("finish", () => {
      const durationMs = getElapsedMs() ?? 0;
      const route = `${req.baseUrl}${req.route?.path ?? req.path}`;

      logger.info("http_request", {
        method: req.method,
        path: req.originalUrl,
        route,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
      });

      requestMetrics.record({
        route,
        method: req.method,
        status: res.statusCode,
        durationMs,
      });
    });
    next();
  };
}
