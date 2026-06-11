import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";

/**
 * Tratamento centralizado de erros. Normaliza AppError, ZodError e erros
 * conhecidos do Prisma para respostas JSON consistentes.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      details: err.details ?? undefined,
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Erro de validação",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({
        error: "Registro duplicado",
        details: { target: err.meta?.target },
      });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Recurso não encontrado" });
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.error("[UnhandledError]", err);
  res.status(500).json({
    error: "Erro interno do servidor",
    details:
      env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : undefined,
  });
}

/** 404 para rotas não mapeadas. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Rota não encontrada" });
}
