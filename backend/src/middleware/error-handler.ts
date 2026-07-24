import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { recordError } from "../lib/error-log.js";

/**
 * Loga (stack completo, JSON estruturado) e persiste (ErrorLog, best-effort)
 * todo erro tratado pelo errorHandler — cobre a regra de observabilidade
 * "todo erro deve ter stack trace completo", visível no painel super-admin.
 */
function captureError(req: Request, statusCode: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  logger.error("request_error", {
    err,
    method: req.method,
    path: req.originalUrl,
    statusCode,
  });

  void recordError({
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    message,
    stack,
    companyId: req.user?.companyId ?? null,
    actorId: req.user?.id ?? null,
  });
}

/**
 * Tratamento centralizado de erros. Normaliza AppError, ZodError e erros
 * conhecidos do Prisma para respostas JSON consistentes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    captureError(req, err.statusCode, err);
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details ?? undefined,
      requestId: req.id,
    });
    return;
  }

  if (err instanceof ZodError) {
    captureError(req, 400, err);
    res.status(400).json({
      error: "Erro de validação",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
      requestId: req.id,
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      captureError(req, 409, err);
      res.status(409).json({
        error: "Registro duplicado",
        details: { target: err.meta?.target },
        requestId: req.id,
      });
      return;
    }
    if (err.code === "P2025") {
      captureError(req, 404, err);
      res.status(404).json({ error: "Recurso não encontrado", requestId: req.id });
      return;
    }
  }

  captureError(req, 500, err);
  res.status(500).json({
    error: "Erro interno do servidor",
    details:
      env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : undefined,
    requestId: req.id,
  });
}

/** 404 para rotas não mapeadas. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "Rota não encontrada", requestId: req.id });
}
