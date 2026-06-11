import type { NextFunction, Request, Response } from "express";

/**
 * Envolve handlers async para propagar rejeições ao errorHandler do Express.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
