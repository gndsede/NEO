import type { DocumentType, Prisma, UserProfile } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "./prisma.js";
import { Forbidden } from "./errors.js";
import type { PermissionList } from "./permissions.js";

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
  /// Se true, o usuário enxerga todas as obras do tenant automaticamente
  /// (independente da permissão obras.manage, que só rege o CRUD de obras).
  allObrasAccess: boolean;
  /// Tipos de documento (SAFETY/STANDARD) que o usuário pode visualizar,
  /// derivado dos grupos (UserGroup) aos quais pertence. `null` = sem
  /// restrição (vê todos os tipos) — padrão para usuários fora de grupos
  /// restritivos.
  allowedDocumentTypes: DocumentType[] | null;
}

/**
 * Calcula os tipos de documento visíveis para o usuário a partir dos grupos
 * (UserGroup) aos quais pertence. Um grupo com `visibleDocumentTypes` vazio
 * concede acesso irrestrito; a presença de QUALQUER grupo assim (ou a
 * ausência de grupos) já torna o usuário irrestrito (união permissiva).
 * Só restringe quando TODOS os grupos do usuário definem uma lista restrita.
 */
export async function loadAllowedDocumentTypesForUser(params: {
  userId: string;
  companyId: string;
}): Promise<DocumentType[] | null> {
  const memberships = await prisma.userGroupMember.findMany({
    where: { userId: params.userId, group: { companyId: params.companyId, active: true } },
    select: { group: { select: { visibleDocumentTypes: true } } },
  });

  if (memberships.length === 0) return null;

  const restricted = new Set<DocumentType>();
  for (const { group } of memberships) {
    if (group.visibleDocumentTypes.length === 0) return null;
    for (const t of group.visibleDocumentTypes) restricted.add(t);
  }
  return [...restricted];
}

export async function loadObraIdsForUser(params: {
  userId: string;
  companyId: string;
  permissions: PermissionList;
  allObrasAccess: boolean;
}): Promise<string[]> {
  if (params.allObrasAccess) {
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

/**
 * Filtro Prisma para Worker no novo modelo com WorkerAssignment.
 * Workers são filtrados via seu vínculo (assignment) com as obras do escopo.
 */
export function workerScopeWhere(scope: AuthScope): Prisma.WorkerWhereInput {
  const assignmentFilter: Prisma.WorkerAssignmentWhereInput = {};

  if (scope.activeObraId) {
    assignmentFilter.obraId = scope.activeObraId;
  } else if (scope.obraIds.length > 0) {
    assignmentFilter.obraId = { in: scope.obraIds };
  }

  if (scope.profile === "COLLABORATOR" && scope.contractorId) {
    assignmentFilter.contractorId = scope.contractorId;
  }

  return {
    companyId: scope.companyId,
    assignments: { some: assignmentFilter },
  };
}

/**
 * Retorna o filtro de assignment para o escopo do usuário.
 * Usado quando se quer filtrar diretamente sobre WorkerAssignment.
 */
export function assignmentScopeWhere(
  scope: AuthScope,
): Prisma.WorkerAssignmentWhereInput {
  const where: Prisma.WorkerAssignmentWhereInput = {
    companyId: scope.companyId,
  };

  if (scope.activeObraId) {
    where.obraId = scope.activeObraId;
  } else if (scope.obraIds.length > 0) {
    where.obraId = { in: scope.obraIds };
  }

  if (scope.profile === "COLLABORATOR" && scope.contractorId) {
    where.contractorId = scope.contractorId;
  }

  return where;
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
