import { RequirementCollectionStatus } from "@prisma/client";
import type { AuthScope } from "../../lib/scope.js";
import { buildSignedQrPayload, NEO_QR_SPEC } from "../../utils/access-hash.js";

type ScopeForPresentation = Pick<
  AuthScope,
  "activeObraId" | "obraIds" | "allowedDocumentTypes"
>;

/** Remove documentos/exigências de tipos (SAFETY/STANDARD) fora do escopo do grupo do usuário. */
function filterByAllowedDocumentTypes<T extends { type?: string; documentType?: string }>(
  items: T[],
  allowedDocumentTypes: AuthScope["allowedDocumentTypes"],
): T[] {
  if (!allowedDocumentTypes) return items;
  const allowed = new Set<string>(allowedDocumentTypes);
  return items.filter((item) => {
    const type = item.documentType ?? item.type;
    return type === undefined || allowed.has(type);
  });
}

type WorkerWithToken = { qrHash: string };

type AssignmentLike = {
  id: string;
  obraId: string;
  role?: string;
  registration?: string | null;
  admissionDate?: Date | null;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  laborType?: string;
  status?: string;
  phase?: string;
  phaseUpdatedAt?: Date | null;
  functionId?: string | null;
  contractor?: { id: string; name: string; cnpj?: string | null } | null;
  obra?: { id: string; name: string } | null;
  function?: { id: string; name: string } | null;
  requirementItems?: Array<{
    id?: string;
    name?: string;
    documentType?: string;
    effectiveStatus?: string;
    expiresAt?: Date | null;
    status?: string;
    phase?: string;
    requirement?: { id: string; name: string; frequency: string } | null;
  }>;
};

type WorkerWithAssignments = WorkerWithToken & {
  assignments?: AssignmentLike[];
  [key: string]: unknown;
};

/** Escolhe o vínculo (assignment) relevante para o escopo atual do usuário. */
export function pickPrimaryAssignment(
  assignments: AssignmentLike[],
  scope: Pick<AuthScope, "activeObraId" | "obraIds">,
): AssignmentLike | undefined {
  if (assignments.length === 0) return undefined;

  if (scope.activeObraId) {
    return (
      assignments.find((a) => a.obraId === scope.activeObraId) ??
      assignments.find((a) => scope.obraIds.includes(a.obraId))
    );
  }

  return (
    assignments.find((a) => scope.obraIds.includes(a.obraId)) ?? assignments[0]
  );
}

/** Achata o assignment primário sobre o worker — contrato esperado pelo frontend legado. */
export function flattenWorker<T extends WorkerWithAssignments>(
  worker: T,
  scope: ScopeForPresentation,
): T {
  const assignment = pickPrimaryAssignment(worker.assignments ?? [], scope);

  const documents = Array.isArray(worker.documents)
    ? filterByAllowedDocumentTypes(
        worker.documents as Array<{ type?: string }>,
        scope.allowedDocumentTypes,
      )
    : worker.documents;

  if (!assignment) {
    return { ...worker, documents, requirementItems: [] } as T;
  }

  const requirementItems = filterByAllowedDocumentTypes(
    assignment.requirementItems ?? [],
    scope.allowedDocumentTypes,
  ).map((item) => ({
    ...item,
    isNotApplicable: item.status === RequirementCollectionStatus.NOT_APPLICABLE,
  }));

  return {
    ...worker,
    documents,
    assignmentId: assignment.id,
    role: assignment.role,
    registration: assignment.registration ?? null,
    admissionDate: assignment.admissionDate ?? null,
    shiftStart: assignment.shiftStart ?? null,
    shiftEnd: assignment.shiftEnd ?? null,
    laborType: assignment.laborType,
    status: assignment.status,
    phase: assignment.phase,
    phaseUpdatedAt: assignment.phaseUpdatedAt ?? null,
    functionId: assignment.functionId ?? null,
    contractor: assignment.contractor ?? null,
    obra: assignment.obra ?? null,
    function: assignment.function ?? null,
    requirementItems,
  } as T;
}

export function presentWorker<T extends WorkerWithAssignments>(
  worker: T,
  scope: ScopeForPresentation,
) {
  return withAccessToken(flattenWorker(worker, scope), scope);
}

export function withAccessToken<T extends WorkerWithToken>(
  worker: T,
  scope?: ScopeForPresentation,
) {
  const base =
    scope && "assignments" in worker
      ? flattenWorker(worker as WorkerWithAssignments & T, scope)
      : worker;

  return {
    ...base,
    accessToken: worker.qrHash,
  };
}

export function accessTokenPayload(qrHash: string) {
  return {
    accessToken: qrHash,
    // QRs novos devem embutir o payload assinado (HMAC), não o token cru.
    qrPayload: buildSignedQrPayload(qrHash),
    format: NEO_QR_SPEC.signedPattern,
    spec: NEO_QR_SPEC,
  };
}
