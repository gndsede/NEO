import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { UserProfile } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
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

/** Audience dos tokens de sessão. Distingue de tokens de pré-2FA ("pre-auth")
 *  e de super-admin ("super-admin"), que NÃO valem como sessão de usuário. */
export const ACCESS_TOKEN_AUDIENCE = "access";

export interface AccessTokenClaims {
  sub: string;
  companyId: string;
  profile: UserProfile;
  email: string;
  contractorId: string | null;
  permissions?: PermissionList;
  aud?: string;
}

export function signUserToken(user: AuthUser): string {
  const claims: AccessTokenClaims = {
    sub: user.id,
    companyId: user.companyId,
    profile: user.profile,
    email: user.email,
    contractorId: user.contractorId,
    permissions: user.permissions,
    aud: ACCESS_TOKEN_AUDIENCE,
  };
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

async function buildAuthUser(
  decoded: AccessTokenClaims,
  req: Request,
): Promise<AuthUser> {
  // Checagem por requisição: usuário ainda ativo e empresa em situação regular.
  // Garante que desativação de conta / bloqueio de tenant derrube sessões vivas.
  const account = await prisma.user.findFirst({
    where: { id: decoded.sub, companyId: decoded.companyId },
    select: {
      active: true,
      company: { select: { blocked: true, licenseExpiresAt: true } },
    },
  });
  if (!account?.active) {
    throw Unauthorized("Conta desativada ou inexistente.");
  }
  if (account.company.blocked) {
    throw Forbidden("Empresa bloqueada. Entre em contato com o suporte NEO.");
  }
  if (
    account.company.licenseExpiresAt &&
    account.company.licenseExpiresAt < new Date()
  ) {
    throw Forbidden("Licença expirada. Entre em contato com o suporte NEO.");
  }

  const permissions = normalizePermissions(decoded.permissions);
  const obraIds = await loadObraIdsForUser({
    userId: decoded.sub,
    companyId: decoded.companyId,
    permissions,
  });

  // Gestores de obra podem acessar o sistema mesmo sem obras ativas (ex.: cadastrar a primeira).
  if (
    obraIds.length === 0 &&
    !hasCapability({ permissions }, "obras.manage")
  ) {
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
      const decoded = jwt.verify(token, env.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as AccessTokenClaims;
      // Rejeita tokens de outros fluxos (pré-2FA, super-admin) usados como sessão.
      if (decoded.aud !== ACCESS_TOKEN_AUDIENCE) {
        throw Unauthorized("Token inválido para esta operação");
      }
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
