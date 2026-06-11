import type { Prisma, UserProfile } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "./prisma.js";
import { Forbidden } from "./errors.js";
import { hasCapability, type PermissionList } from "./permissions.js";

export const OBRA_HEADER = "x-obra-id";

export interface AuthScope {
  id: string;
  companyId: string;
  profile: UserProfile;
  email: string;
  permissions: PermissionList;
  contractorId: string | null;
  obraIds: string[];
  activeObraId: string | null;
}

export async function loadObraIdsForUser(params: {
  userId: string;
  companyId: string;
  permissions: PermissionList;
}): Promise<string[]> {
  if (hasCapability({ permissions: params.permissions }, "obras.manage")) {
    const obras = await prisma.obra.findMany({
      where: { companyId: params.companyId, active: true },
      select: { id: true },
    });
    return obras.map((o) => o.id);
  }

  const access = await prisma.userObraAccess.findMany({
    where: {
      userId: params.userId,
      obra: { companyId: params.companyId, active: true },
    },
    select: { obraId: true },
  });
  return access.map((a) => a.obraId);
}

export function resolveActiveObraId(
  req: Request,
  obraIds: string[],
): string | null {
  const raw = req.headers[OBRA_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  if (!obraIds.includes(header)) {
    throw Forbidden("Você não tem acesso a esta obra.");
  }
  return header;
}

export function obraWhere(scope: Pick<AuthScope, "obraIds" | "activeObraId">) {
  if (scope.activeObraId) {
    return { obraId: scope.activeObraId };
  }
  return { obraId: { in: scope.obraIds } };
}

export function contractorWhere(
  scope: Pick<AuthScope, "profile" | "contractorId">,
) {
  if (scope.profile === "COLLABORATOR" && scope.contractorId) {
    return { id: scope.contractorId };
  }
  return {};
}

export async function ensureObraAccess(
  scope: AuthScope,
  obraId: string,
): Promise<void> {
  if (!scope.obraIds.includes(obraId)) {
    throw Forbidden("Você não tem acesso a esta obra.");
  }
}

export async function ensureContractorInScope(
  scope: AuthScope,
  contractorId: string,
): Promise<{ id: string; obraId: string }> {
  const contractor = await prisma.contractor.findFirst({
    where: {
      id: contractorId,
      companyId: scope.companyId,
      ...obraWhere(scope),
      ...contractorWhere(scope),
    },
    select: { id: true, obraId: true },
  });
  if (!contractor) {
    throw Forbidden("Empreiteira não encontrada ou fora do seu escopo.");
  }
  return contractor;
}

export function scopeFromRequest(req: Request): AuthScope {
  if (!req.user) {
    throw Forbidden("Usuário não autenticado.");
  }
  return req.user as AuthScope;
}

export function workerScopeWhere(scope: AuthScope): Prisma.WorkerWhereInput {
  return {
    companyId: scope.companyId,
    ...obraWhere(scope),
    ...(scope.profile === "COLLABORATOR" && scope.contractorId
      ? { contractorId: scope.contractorId }
      : {}),
  };
}

export function contractorScopeWhere(
  scope: AuthScope,
): Prisma.ContractorWhereInput {
  return {
    companyId: scope.companyId,
    ...obraWhere(scope),
    ...contractorWhere(scope),
  };
}

export function requiredObraId(scope: AuthScope): string {
  if (scope.activeObraId) return scope.activeObraId;
  if (scope.obraIds.length === 1) return scope.obraIds[0]!;
  throw Forbidden(
    "Selecione uma obra ativa (header X-Obra-Id) para esta operação.",
  );
}
