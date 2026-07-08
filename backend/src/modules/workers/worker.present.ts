import { RequirementCollectionStatus } from "@prisma/client";
import type { AuthScope } from "../../lib/scope.js";
import { NEO_QR_SPEC } from "../../utils/access-hash.js";

type WorkerWithToken = { qrHash: string };

type AssignmentLike = {
  id: string;
  obraId: string;
  role?: string;
  registration?: string | null;
  admissionDate?: Date | null;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  status?: string;
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
  scope: Pick<AuthScope, "activeObraId" | "obraIds">,
): T {
  const assignment = pickPrimaryAssignment(worker.assignments ?? [], scope);

  if (!assignment) {
    return { ...worker, requirementItems: [] } as T;
  }

  const requirementItems = (assignment.requirementItems ?? []).map((item) => ({
    ...item,
    isNotApplicable: item.status === RequirementCollectionStatus.NOT_APPLICABLE,
  }));

  return {
    ...worker,
    assignmentId: assignment.id,
    role: assignment.role,
    registration: assignment.registration ?? null,
    admissionDate: assignment.admissionDate ?? null,
    shiftStart: assignment.shiftStart ?? null,
    shiftEnd: assignment.shiftEnd ?? null,
    status: assignment.status,
    functionId: assignment.functionId ?? null,
    contractor: assignment.contractor ?? null,
    obra: assignment.obra ?? null,
    function: assignment.function ?? null,
    requirementItems,
  } as T;
}

export function presentWorker<T extends WorkerWithAssignments>(
  worker: T,
  scope: Pick<AuthScope, "activeObraId" | "obraIds">,
) {
  return withAccessToken(flattenWorker(worker, scope), scope);
}

export function withAccessToken<T extends WorkerWithToken>(
  worker: T,
  scope?: Pick<AuthScope, "activeObraId" | "obraIds">,
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
    qrPayload: qrHash,
    format: NEO_QR_SPEC.pattern,
    spec: NEO_QR_SPEC,
  };
}
