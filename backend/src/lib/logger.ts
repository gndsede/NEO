import { getRequestId } from "../middleware/request-context.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

/**
 * Serializa erros preservando stack trace completo — necessário para
 * debugging em produção (stdout do Railway é a fonte de verdade dos logs).
 */
function serializeError(err: unknown): LogMeta {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack,
    };
  }
  return { error: err };
}

function write(level: LogLevel, msg: string, meta?: LogMeta): void {
  const { err, ...rest } = meta ?? {};
  const line = {
    level,
    time: new Date().toISOString(),
    msg,
    requestId: getRequestId(),
    ...rest,
    ...(err !== undefined ? serializeError(err) : {}),
  };
  // Uma linha JSON por evento — nunca texto livre (facilita parsing por
  // qualquer agregador de logs, incl. o painel de observabilidade).
  const out = level === "error" || level === "warn" ? console.error : console.log;
  // eslint-disable-next-line no-console
  out(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, meta?: LogMeta) => write("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => write("info", msg, meta),
  warn: (msg: string, meta?: LogMeta) => write("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => write("error", msg, meta),
};
