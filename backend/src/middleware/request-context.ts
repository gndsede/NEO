import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

interface RequestContext {
  requestId: string;
  startedAtNs: bigint;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * Atribui um Request ID único a cada requisição (reaproveita `X-Request-Id`
 * se o chamador já enviou um, ex.: proxy/API gateway) e o propaga via
 * AsyncLocalStorage — permite que logger, métricas e o listener de queries
 * do Prisma correlacionem tudo a uma requisição sem precisar receber `req`
 * como parâmetro em cada função.
 */
export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      (typeof incoming === "string" && incoming.trim()) || randomUUID();

    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    als.run({ requestId, startedAtNs: process.hrtime.bigint() }, () => next());
  };
}

/** ID da requisição em curso (fora de uma requisição, retorna undefined). */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

/** Duração decorrida desde o início da requisição em curso, em ms. */
export function getElapsedMs(): number | undefined {
  const startedAtNs = als.getStore()?.startedAtNs;
  if (startedAtNs === undefined) return undefined;
  return Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
}
