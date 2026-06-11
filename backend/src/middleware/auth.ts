import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { UserProfile } from "@prisma/client";
import { env } from "../config/env.js";
import { Forbidden, Unauthorized } from "../lib/errors.js";
import {
  hasAnyCapability,
  hasCapability,
  normalizePermissions,
  type PermissionKey,
  type PermissionList,
} from "../lib/permissions.js";
import {
  loadObraIdsForUser,
  resolveActiveObraId,
  type AuthScope,
} from "../lib/scope.js";

export interface AuthUser extends AuthScope {}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface AccessTokenClaims {
  sub: string;
  companyId: string;
  profile: UserProfile;
  email: string;
  contractorId: string | null;
  permissions?: PermissionList;
}

export function signUserToken(user: AuthUser): string {
  const claims: AccessTokenClaims = {
    sub: user.id,
    companyId: user.companyId,
    profile: user.profile,
    email: user.email,
    contractorId: user.contractorId,
    permissions: user.permissions,
  };
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

async function buildAuthUser(
  decoded: AccessTokenClaims,
  req: Request,
): Promise<AuthUser> {
  const permissions = normalizePermissions(decoded.permissions);
  const obraIds = await loadObraIdsForUser({
    userId: decoded.sub,
    companyId: decoded.companyId,
    permissions,
  });

  if (obraIds.length === 0) {
    throw Forbidden("Nenhuma obra liberada para este usuário.");
  }

  const activeObraId = resolveActiveObraId(req, obraIds);

  return {
    id: decoded.sub,
    companyId: decoded.companyId,
    profile: decoded.profile ?? "USER",
    email: decoded.email,
    permissions,
    contractorId: decoded.contractorId ?? null,
    obraIds,
    activeObraId,
  };
}

export function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        throw Unauthorized("Token de acesso ausente");
      }
      const token = header.slice("Bearer ".length).trim();
      const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenClaims;
      req.user = await buildAuthUser(decoded, req);
      next();
    } catch (e) {
      if (e instanceof jwt.JsonWebTokenError || e instanceof jwt.TokenExpiredError) {
        next(Unauthorized("Token inválido ou expirado"));
        return;
      }
      next(e);
    }
  })();
}

/** Exige ao menos uma das permissões listadas. */
export function requireCapability(...keys: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw Unauthorized();
    if (!hasAnyCapability(req.user, keys)) {
      throw Forbidden("Você não tem permissão para esta ação");
    }
    next();
  };
}

/** Exige uma permissão específica. */
export function requirePermission(key: PermissionKey) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw Unauthorized();
    if (!hasCapability(req.user, key)) {
      throw Forbidden("Você não tem permissão para esta ação");
    }
    next();
  };
}
