/**
 * Erro de aplicação com status HTTP. Capturado pelo errorHandler global.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const BadRequest = (msg: string, details?: unknown) =>
  new AppError(400, msg, details);
export const Unauthorized = (msg = "Não autenticado") => new AppError(401, msg);
export const Forbidden = (msg = "Acesso negado") => new AppError(403, msg);
export const NotFound = (msg = "Recurso não encontrado") =>
  new AppError(404, msg);
export const Conflict = (msg: string) => new AppError(409, msg);
