import {
  DocumentOwnerType,
  DocumentStatus,
  RequirementCollectionStatus,
  RequirementFrequency,
  RequirementSource,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getStorage } from "../../lib/storage/index.js";
import { BadRequest, Conflict, NotFound } from "../../lib/errors.js";
import {
  contractorScopeWhere,
  ensureContractorInScope,
  assignmentScopeWhere,
  type AuthScope,
  workerScopeWhere,
} from "../../lib/scope.js";
import { generateNeoAccessToken } from "../../utils/access-hash.js";
import { recomputeRequirementItem, recomputeWorkerRequirements } from "../requirements/requirement-status.js";
import { decrypt, encrypt, hashCpf } from "../../lib/crypto.js";
import { env } from "../../config/env.js";
import { pickPrimaryAssignment } from "./worker.present.js";
import {
  importWorkerRowSchema,
  type AddManualWorkerRequirementInput,
  type CreateAssignmentInput,
  type CreateWorkerInput,
  type DocumentMeta,
  type ListAllRequirementsQuery,
  type ListWorkersQuery,
  type SetWorkerRequirementApplicabilityInput,
  type UpdateAssignmentInput,
  type UpdateWorkerInput,
} from "./worker.schema.js";

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

interface CreateWorkerParams {
  scope: AuthScope;
  data: CreateWorkerInput;
  photo?: UploadedFile;
  documents?: UploadedFile[];
  createdById?: string;
}

/** Include padrão para um Worker com dados completos de todos os vínculos. */
const WORKER_FULL_INCLUDE = {
  assignments: {
    include: {
      contractor: { select: { id: true, name: true, cnpj: true } },
      obra: { select: { id: true, name: true } },
      function: { select: { id: true, name: true } },
      requirementItems: {
        select: {
          id: true,
          name: true,
          documentType: true,
          effectiveStatus: true,
          expiresAt: true,
          status: true,
          requirement: {
            select: { id: true, name: true, frequency: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
  documents: true,
} satisfies Prisma.WorkerInclude;

/** Include para listagem (mais leve). */
const WORKER_LIST_INCLUDE = {
  assignments: {
    include: {
      contractor: { select: { id: true, name: true } },
      obra: { select: { id: true, name: true } },
      requirementItems: { select: { effectiveStatus: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.WorkerInclude;

/**
 * Classifica o turno do vínculo para o filtro da listagem.
 */
/**
 * Decripta os campos PII de um Worker retornado pelo Prisma.
 * Aplica decrypt() em cpf e rg (sem efeito se ENCRYPTION_KEY não estiver configurada).
 */
function decryptWorker<T extends { cpf: string; rg: string | null }>(w: T): T {
  return { ...w, cpf: decrypt(w.cpf), rg: w.rg ? decrypt(w.rg) : null };
}

function matchesShift(
  shiftStart: string | null,
  shiftEnd: string | null,
  filter: "DAY" | "NIGHT" | "NONE",
): boolean {
  if (!shiftStart || !shiftEnd) return filter === "NONE";
  const isNight = shiftStart > shiftEnd;
  return filter === "NIGHT" ? isNight : filter === "DAY" ? !isNight : false;
}

function tokenize(raw: string): string[] {
  return raw.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Pré-filtra IDs de workers por texto usando unaccent do Postgres.
 * Busca nos campos pessoais do worker (fullName, rg, cpf, email, qrHash).
 */
async function workerIdsMatchingText(params: {
  companyId: string;
  obraIds?: string[];
  activeObraId?: string | null;
  filters: Array<{ field: "fullName" | "rg" | "email"; raw: string }>;
}): Promise<string[]> {
  const { companyId, obraIds, activeObraId, filters } = params;
  const conditions: string[] = [];
  const values: string[] = [];
  let i = 1;

  for (const { field, raw } of filters) {
    for (const t of tokenize(raw)) {
      conditions.push(
        `unaccent(lower(w."${field}")) LIKE unaccent(lower($${i}))`,
      );
      values.push(`%${t}%`);
      i += 1;
    }
  }

  if (conditions.length === 0) return [];

  const companyParam = `$${i}`;
  values.push(companyId);
  i += 1;

  // Filtra por obra via join com worker_assignments
  let obraJoin = "";
  if (activeObraId) {
    obraJoin = `INNER JOIN "worker_assignments" wa ON wa."workerId" = w.id AND wa."obraId" = $${i}`;
    values.push(activeObraId);
    i += 1;
  } else if (obraIds && obraIds.length > 0) {
    const placeholders = obraIds.map((_, k) => `$${i + k}`).join(",");
    obraJoin = `INNER JOIN "worker_assignments" wa ON wa."workerId" = w.id AND wa."obraId" IN (${placeholders})`;
    values.push(...obraIds);
    i += obraIds.length;
  }

  const sql = `SELECT DISTINCT w.id FROM "workers" w
    ${obraJoin}
    WHERE w."companyId" = ${companyParam}
      AND ${conditions.join(" AND ")}`;

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...values);
  return rows.map((r) => r.id);
}

/**
 * Busca global: cada token deve aparecer em pelo menos um de
 * {fullName, qrHash, cpf}. Insensível a acento e caixa.
 */
async function workerIdsMatchingGlobal(params: {
  companyId: string;
  obraIds?: string[];
  activeObraId?: string | null;
  raw: string;
}): Promise<string[]> {
  const { companyId, obraIds, activeObraId, raw } = params;
  const tokens = tokenize(raw);
  if (tokens.length === 0) return [];

  const values: string[] = [];
  let i = 1;
  const perTokenAnds: string[] = [];

  for (const t of tokens) {
    const tokenOr: string[] = [];
    tokenOr.push(`unaccent(lower(w."fullName")) LIKE unaccent(lower($${i}))`);
    values.push(`%${t}%`);
    i += 1;

    tokenOr.push(`lower(w."qrHash") LIKE lower($${i})`);
    values.push(`%${t}%`);
    i += 1;

    const digits = t.replace(/\D/g, "");
    if (digits.length > 0) {
      if (env.ENCRYPTION_KEY) {
        // CPF criptografado: somente match exato por hash (11 dígitos)
        if (digits.length === 11) {
          tokenOr.push(`w."cpfHash" = $${i}`);
          values.push(hashCpf(digits));
          i += 1;
        }
      } else {
        tokenOr.push(`w."cpf" LIKE $${i}`);
        values.push(`%${digits}%`);
        i += 1;
      }
    }
    perTokenAnds.push(`(${tokenOr.join(" OR ")})`);
  }

  const companyParam = `$${i}`;
  values.push(companyId);
  i += 1;

  let obraJoin = "";
  if (activeObraId) {
    obraJoin = `INNER JOIN "worker_assignments" wa ON wa."workerId" = w.id AND wa."obraId" = $${i}`;
    values.push(activeObraId);
    i += 1;
  } else if (obraIds && obraIds.length > 0) {
    const placeholders = obraIds.map((_, k) => `$${i + k}`).join(",");
    obraJoin = `INNER JOIN "worker_assignments" wa ON wa."workerId" = w.id AND wa."obraId" IN (${placeholders})`;
    values.push(...obraIds);
    i += obraIds.length;
  }

  const sql = `SELECT DISTINCT w.id FROM "workers" w
    ${obraJoin}
    WHERE w."companyId" = ${companyParam}
      AND ${perTokenAnds.join(" AND ")}`;

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...values);
  return rows.map((r) => r.id);
}

export class WorkerService {
  private async generateUniqueQrHash(): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const token = generateNeoAccessToken();
      const exists = await prisma.worker.findUnique({
        where: { qrHash: token },
        select: { id: true },
      });
      if (!exists) return token;
    }
    throw BadRequest("Não foi possível gerar token de acesso único. Tente novamente.");
  }

  private async ensureWorkerFunctionBelongsToCompany(
    companyId: string,
    functionId: string,
  ) {
    const fn = await prisma.workerFunction.findFirst({
      where: { id: functionId, companyId, active: true },
      select: { id: true },
    });
    if (!fn) throw NotFound("Função de colaborador não encontrada para esta empresa");
  }

  private matchRequirementItem(
    items: Array<{ id: string; documentType: string; name: string }>,
    meta: DocumentMeta,
  ) {
    const byType = items.find((item) => item.documentType === meta.type);
    if (byType) return byType;
    if (!meta.title) return undefined;
    const title = meta.title.toLowerCase();
    return (
      items.find((item) => item.name.toLowerCase() === title) ??
      items.find((item) => item.name.toLowerCase().includes(title))
    );
  }

  /**
   * Sincroniza exigências de uma função para um assignment específico.
   * Não duplica exigências já existentes para o mesmo assignment.
   */
  private async syncFunctionRequirementsToAssignment(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      workerId: string;
      assignmentId: string;
      functionId: string;
      createdById?: string;
    },
  ) {
    const defs = await tx.workerFunctionRequirement.findMany({
      where: {
        functionId: params.functionId,
        required: true,
        requirement: { companyId: params.companyId, active: true, target: "WORKER" },
      },
      include: { requirement: true },
    });

    const existing = await tx.workerRequirementItem.findMany({
      where: {
        companyId: params.companyId,
        assignmentId: params.assignmentId,
        source: RequirementSource.FUNCTION_TEMPLATE,
        requirementId: { not: null },
      },
      select: { requirementId: true },
    });
    const existingRequirementIds = new Set(existing.map((item) => item.requirementId));

    for (const rel of defs) {
      if (existingRequirementIds.has(rel.requirementId)) continue;
      await tx.workerRequirementItem.create({
        data: {
          companyId: params.companyId,
          workerId: params.workerId,
          assignmentId: params.assignmentId,
          requirementId: rel.requirementId,
          source: RequirementSource.FUNCTION_TEMPLATE,
          status: RequirementCollectionStatus.NOT_SENT,
          name: rel.requirement.name,
          documentType: rel.requirement.documentType,
          frequency: rel.requirement.frequency,
          monthlyDueDay: rel.requirement.monthlyDueDay ?? undefined,
          referenceDate: rel.requirement.referenceDate ?? undefined,
          createdById: params.createdById,
        },
      });
    }
  }

  /**
   * Cadastro completo de um colaborador:
   * 1. Se CPF já existir na company → usa o Worker existente e cria novo Assignment.
   * 2. Se CPF é novo → cria Worker + Assignment em transação.
   * 3. Faz upload da foto e dos documentos no storage.
   */
  async create({
    scope,
    data,
    photo,
    documents,
    createdById,
  }: CreateWorkerParams) {
    const companyId = scope.companyId;
    const contractor = await ensureContractorInScope(scope, data.contractorId);

    if (data.functionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, data.functionId);
    }

    const docsMeta = data.documentsMeta ?? [];
    if (documents && documents.length !== docsMeta.length) {
      throw BadRequest(
        `Quantidade de arquivos (${documents.length}) difere dos metadados em documentsMeta (${docsMeta.length}).`,
      );
    }

    // Verifica se já existe worker com este CPF na company (multi-obra)
    const cpfHash = hashCpf(data.cpf);
    const existingWorker = await prisma.worker.findUnique({
      where: { companyId_cpfHash: { companyId, cpfHash } },
      select: { id: true },
    });

    // Se worker já existir, verifica se já tem assignment nesta obra
    if (existingWorker) {
      const existingAssignment = await prisma.workerAssignment.findUnique({
        where: {
          obraId_workerId: {
            obraId: contractor.obraId,
            workerId: existingWorker.id,
          },
        },
        select: { id: true },
      });
      if (existingAssignment) {
        throw Conflict("Colaborador com este CPF já está cadastrado nesta obra");
      }
    }

    const storage = await getStorage();

    let photoUrl: string | undefined;
    if (photo && !existingWorker) {
      const stored = await storage.upload({
        buffer: photo.buffer,
        originalName: photo.originalname,
        mimeType: photo.mimetype,
        folder: `companies/${companyId}/workers/photos`,
      });
      photoUrl = stored.url;
    } else if (photo && existingWorker) {
      // Atualiza foto do worker existente
      const stored = await storage.upload({
        buffer: photo.buffer,
        originalName: photo.originalname,
        mimeType: photo.mimetype,
        folder: `companies/${companyId}/workers/photos`,
      });
      await prisma.worker.update({
        where: { id: existingWorker.id },
        data: { photoUrl: stored.url },
      });
    }

    const uploadedDocs = await Promise.all(
      (documents ?? []).map(async (file, idx) => {
        const meta: DocumentMeta = docsMeta[idx];
        const stored = await storage.upload({
          buffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
          folder: `companies/${companyId}/workers/documents`,
        });
        return { file, meta, stored };
      }),
    );

    const worker = await prisma.$transaction(async (tx) => {
      let workerId: string;

      if (existingWorker) {
        workerId = existingWorker.id;
      } else {
        const qrHash = await this.generateUniqueQrHash();
        const created = await tx.worker.create({
          data: {
            companyId,
            fullName: data.fullName,
            cpf: encrypt(data.cpf),
            cpfHash,
            rg: data.rg ? encrypt(data.rg) : null,
            birthDate: data.birthDate,
            email: data.email,
            phone: data.phone,
            photoUrl,
            qrHash,
          },
        });
        workerId = created.id;
      }

      // Cria o vínculo com a obra
      const assignment = await tx.workerAssignment.create({
        data: {
          companyId,
          workerId,
          obraId: contractor.obraId,
          contractorId: data.contractorId,
          functionId: data.functionId,
          role: data.role,
          registration: data.registration,
          admissionDate: data.admissionDate,
          shiftStart: data.shiftStart,
          shiftEnd: data.shiftEnd,
        },
      });

      if (data.functionId) {
        await this.syncFunctionRequirementsToAssignment(tx, {
          companyId,
          workerId,
          assignmentId: assignment.id,
          functionId: data.functionId,
          createdById,
        });
      }

      if (uploadedDocs.length > 0) {
        const requirementItems = await tx.workerRequirementItem.findMany({
          where: { companyId, assignmentId: assignment.id },
          select: { id: true, documentType: true, name: true },
        });
        const linkedItemIds = new Set<string>();

        for (const { file, meta, stored } of uploadedDocs) {
          const matchingItem = this.matchRequirementItem(requirementItems, meta);
          if (matchingItem) linkedItemIds.add(matchingItem.id);

          const doc = await tx.document.create({
            data: {
              companyId,
              ownerType: DocumentOwnerType.WORKER,
              workerId,
              workerRequirementItemId: matchingItem?.id ?? null,
              type: meta.type,
              title: meta.title,
              fileUrl: stored.url,
              fileKey: stored.key,
              mimeType: file.mimetype,
              fileSize: file.size,
              issuedAt: meta.issuedAt,
              expiresAt: meta.expiresAt,
              status: DocumentStatus.PENDENTE,
              uploadedById: createdById,
            },
          });

          if (matchingItem) {
            await tx.workerRequirementItem.update({
              where: { id: matchingItem.id },
              data: {
                status: RequirementCollectionStatus.PENDING_APPROVAL,
                naReason: null,
                latestDocumentId: doc.id,
              },
            });
          }
        }
      }

      const w = await tx.worker.findUniqueOrThrow({
        where: { id: workerId },
        include: WORKER_FULL_INCLUDE,
      });
      return decryptWorker(w);
    });

    if (uploadedDocs.length > 0) {
      await recomputeWorkerRequirements(worker.id);
    }

    return worker;
  }

  /**
   * Adiciona um colaborador já existente a uma nova obra criando um WorkerAssignment.
   */
  async addAssignment(
    scope: AuthScope,
    workerId: string,
    data: CreateAssignmentInput,
    createdById?: string,
  ) {
    const companyId = scope.companyId;

    const worker = await prisma.worker.findFirst({
      where: { id: workerId, companyId },
      select: { id: true },
    });
    if (!worker) throw NotFound("Colaborador não encontrado");

    const contractor = await ensureContractorInScope(scope, data.contractorId);

    const existing = await prisma.workerAssignment.findUnique({
      where: { obraId_workerId: { obraId: contractor.obraId, workerId } },
      select: { id: true },
    });
    if (existing) {
      throw Conflict("Colaborador já possui vínculo com esta obra");
    }

    if (data.functionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, data.functionId);
    }

    return prisma.$transaction(async (tx) => {
      const assignment = await tx.workerAssignment.create({
        data: {
          companyId,
          workerId,
          obraId: contractor.obraId,
          contractorId: data.contractorId,
          functionId: data.functionId,
          role: data.role,
          registration: data.registration,
          admissionDate: data.admissionDate,
          shiftStart: data.shiftStart,
          shiftEnd: data.shiftEnd,
        },
        include: {
          obra: { select: { id: true, name: true } },
          contractor: { select: { id: true, name: true } },
          function: { select: { id: true, name: true } },
        },
      });

      if (data.functionId) {
        await this.syncFunctionRequirementsToAssignment(tx, {
          companyId,
          workerId,
          assignmentId: assignment.id,
          functionId: data.functionId,
          createdById,
        });
      }

      return assignment;
    });
  }

  /**
   * Importação em lote a partir de linhas de planilha.
   */
  async importBatch(
    scope: AuthScope,
    rows: Array<Record<string, unknown>>,
    createdById?: string,
  ) {
    const companyId = scope.companyId;
    const results: Array<{
      line: number;
      status: "created" | "error";
      message?: string;
      fullName?: string;
    }> = [];

    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = i + 1;
      const parsed = importWorkerRowSchema.safeParse(rows[i]);
      if (!parsed.success) {
        results.push({
          line,
          status: "error",
          message: parsed.error.issues
            .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
            .join("; "),
        });
        continue;
      }
      const data = parsed.data;
      try {
        const contractor = await prisma.contractor.findFirst({
          where: {
            ...contractorScopeWhere(scope),
            name: { equals: data.contractorName, mode: "insensitive" },
          },
          select: { id: true, obraId: true },
        });
        if (!contractor) {
          results.push({
            line,
            status: "error",
            message: `Empreiteira "${data.contractorName}" não encontrada`,
            fullName: data.fullName,
          });
          continue;
        }

        // Verifica duplicidade: mesmo CPF na mesma obra
        const rowCpfHash = hashCpf(data.cpf);
        const existingWorker = await prisma.worker.findUnique({
          where: { companyId_cpfHash: { companyId, cpfHash: rowCpfHash } },
          select: { id: true },
        });
        if (existingWorker) {
          const existingAssignment = await prisma.workerAssignment.findUnique({
            where: {
              obraId_workerId: {
                obraId: contractor.obraId,
                workerId: existingWorker.id,
              },
            },
            select: { id: true },
          });
          if (existingAssignment) {
            results.push({
              line,
              status: "error",
              message: "CPF já cadastrado nesta obra",
              fullName: data.fullName,
            });
            continue;
          }
        }

        let functionId: string | undefined;
        if (data.functionName) {
          const fn = await prisma.workerFunction.upsert({
            where: { companyId_name: { companyId, name: data.functionName } },
            update: {},
            create: { companyId, name: data.functionName },
            select: { id: true },
          });
          functionId = fn.id;
        }

        await this.create({
          scope,
          createdById,
          data: {
            contractorId: contractor.id,
            functionId,
            fullName: data.fullName,
            cpf: data.cpf,
            rg: data.rg,
            birthDate: data.birthDate,
            email: data.email,
            phone: data.phone,
            role: data.role,
            registration: data.registration,
            admissionDate: undefined,
            shiftStart: undefined,
            shiftEnd: undefined,
            documentsMeta: [],
          },
        });
        created += 1;
        results.push({ line, status: "created", fullName: data.fullName });
      } catch (err) {
        results.push({
          line,
          status: "error",
          message: err instanceof Error ? err.message : "Erro desconhecido",
          fullName: data.fullName,
        });
      }
    }

    return { created, total: rows.length, results };
  }

  async findById(scope: AuthScope, id: string) {
    const worker = await prisma.worker.findFirst({
      where: { id, ...workerScopeWhere(scope) },
      include: WORKER_FULL_INCLUDE,
    });
    if (!worker) throw NotFound("Colaborador não encontrado");
    return decryptWorker(worker);
  }

  /** Retorna o assignment primário do escopo atual (para PATCH legado do frontend). */
  async resolvePrimaryAssignmentId(scope: AuthScope, workerId: string) {
    const worker = await prisma.worker.findFirst({
      where: { id: workerId, ...workerScopeWhere(scope) },
      select: {
        assignments: {
          select: { id: true, obraId: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!worker) throw NotFound("Colaborador não encontrado");
    return pickPrimaryAssignment(worker.assignments, scope)?.id ?? null;
  }

  async list(scope: AuthScope, query: ListWorkersQuery) {
    const cpfDigits = query.cpf?.replace(/\D/g, "") || undefined;
    const { companyId, obraIds, activeObraId } = scope;

    // Pré-filtra IDs por texto usando unaccent
    const textFilters: Array<{ field: "fullName" | "rg" | "email"; raw: string }> = [];
    if (query.name) textFilters.push({ field: "fullName", raw: query.name });
    // rg não é pesquisável quando criptografia de campo está ativa
    if (query.rg && !env.ENCRYPTION_KEY) textFilters.push({ field: "rg", raw: query.rg });
    if (query.email) textFilters.push({ field: "email", raw: query.email });

    let textIds: string[] | null = null;
    if (textFilters.length > 0) {
      textIds = await workerIdsMatchingText({
        companyId,
        obraIds,
        activeObraId,
        filters: textFilters,
      });
      if (textIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
    }

    if (query.search) {
      const globalIds = await workerIdsMatchingGlobal({
        companyId,
        obraIds,
        activeObraId,
        raw: query.search,
      });
      if (globalIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
      textIds = textIds === null
        ? globalIds
        : textIds.filter((id) => globalIds.includes(id));
      if (textIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
    }

    // Filtro de assignment para scoping por obra/empreiteira/status
    const assignmentFilter: Prisma.WorkerAssignmentWhereInput =
      assignmentScopeWhere(scope);
    if (query.contractorId) assignmentFilter.contractorId = query.contractorId;
    if (query.functionId) assignmentFilter.functionId = query.functionId;
    if (query.status) assignmentFilter.status = query.status;
    if (query.registration?.trim()) {
      assignmentFilter.registration = {
        contains: query.registration.trim(),
        mode: "insensitive",
      };
    }

    const where: Prisma.WorkerWhereInput = {
      companyId,
      assignments: { some: assignmentFilter },
      // Busca por CPF: partial match em texto plano ou exact match via hash quando criptografado
      ...(cpfDigits
        ? env.ENCRYPTION_KEY
          ? cpfDigits.length === 11
            ? { cpfHash: hashCpf(cpfDigits) }
            : {}
          : { cpf: { contains: cpfDigits } }
        : {}),
      ...(query.hasPhoto === true ? { photoUrl: { not: null } } : {}),
      ...(query.hasPhoto === false ? { photoUrl: null } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lte: query.createdTo } : {}),
            },
          }
        : {}),
      ...(textIds !== null ? { id: { in: textIds } } : {}),
      ...(query.effectiveStatus?.length
        ? {
            assignments: {
              some: {
                ...assignmentFilter,
                requirementItems: {
                  some: { effectiveStatus: { in: query.effectiveStatus } },
                },
              },
            },
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.worker.count({ where }),
      prisma.worker.findMany({
        where,
        include: WORKER_LIST_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    // Filtro de turno em memória — avalia o assignment ativo no escopo
    let filteredItems = items;
    if (query.shift) {
      filteredItems = items.filter((w) => {
        const relevantAssignment = w.assignments.find((a) =>
          scope.activeObraId
            ? a.obraId === scope.activeObraId
            : scope.obraIds.includes(a.obraId),
        );
        return relevantAssignment
          ? matchesShift(
              relevantAssignment.shiftStart,
              relevantAssignment.shiftEnd,
              query.shift!,
            )
          : false;
      });
    }

    return {
      items: filteredItems.map(decryptWorker),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  /** Atualiza dados pessoais (não altera vínculos com obras). */
  async update(scope: AuthScope, id: string, data: UpdateWorkerInput) {
    await this.findById(scope, id);
    const updated = await prisma.worker.update({
      where: { id },
      data: {
        ...data,
        ...(data.rg !== undefined ? { rg: data.rg ? encrypt(data.rg) : null } : {}),
      },
      include: WORKER_FULL_INCLUDE,
    });
    return decryptWorker(updated);
  }

  /** Atualiza um vínculo específico (WorkerAssignment). */
  async updateAssignment(
    scope: AuthScope,
    workerId: string,
    assignmentId: string,
    data: UpdateAssignmentInput,
  ) {
    const companyId = scope.companyId;
    await this.findById(scope, workerId);

    const assignment = await prisma.workerAssignment.findFirst({
      where: { id: assignmentId, workerId, companyId },
      select: { id: true, functionId: true },
    });
    if (!assignment) throw NotFound("Vínculo não encontrado");

    if (data.contractorId) {
      await ensureContractorInScope(scope, data.contractorId);
    }

    const nextFunctionId =
      data.functionId === undefined ? assignment.functionId : data.functionId;
    if (nextFunctionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, nextFunctionId);
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.workerAssignment.update({
        where: { id: assignmentId },
        data: {
          ...(data.contractorId !== undefined ? { contractorId: data.contractorId } : {}),
          ...(data.functionId !== undefined ? { functionId: data.functionId } : {}),
          ...(data.role !== undefined ? { role: data.role } : {}),
          ...(data.registration !== undefined ? { registration: data.registration } : {}),
          ...(data.admissionDate !== undefined ? { admissionDate: data.admissionDate } : {}),
          ...(data.shiftStart !== undefined ? { shiftStart: data.shiftStart } : {}),
          ...(data.shiftEnd !== undefined ? { shiftEnd: data.shiftEnd } : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
        },
        include: {
          obra: { select: { id: true, name: true } },
          contractor: { select: { id: true, name: true } },
          function: { select: { id: true, name: true } },
          requirementItems: { select: { effectiveStatus: true } },
        },
      });

      if (nextFunctionId && nextFunctionId !== assignment.functionId) {
        await this.syncFunctionRequirementsToAssignment(tx, {
          companyId,
          workerId,
          assignmentId,
          functionId: nextFunctionId,
        });
      }

      return updated;
    });
  }

  /** Atualiza apenas a foto do colaborador. */
  async updatePhoto(scope: AuthScope, id: string, photo: UploadedFile) {
    const companyId = scope.companyId;
    await this.findById(scope, id);
    const storage = await getStorage();
    const stored = await storage.upload({
      buffer: photo.buffer,
      originalName: photo.originalname,
      mimeType: photo.mimetype,
      folder: `companies/${companyId}/workers/photos`,
    });
    const updated = await prisma.worker.update({
      where: { id },
      data: { photoUrl: stored.url },
      include: WORKER_FULL_INCLUDE,
    });
    return decryptWorker(updated);
  }

  /**
   * Contadores do funil — exigências por situação efetiva no escopo do usuário.
   */
  async requirementsSummary(scope: AuthScope) {
    const assignmentScope = assignmentScopeWhere(scope);
    const grouped = await prisma.workerRequirementItem.groupBy({
      by: ["effectiveStatus"],
      where: {
        companyId: scope.companyId,
        assignment: assignmentScope,
      },
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      EM_FALTA: 0, AGUARDANDO: 0, REPROVADO: 0,
      VENCIDO: 0, PROX_VENCIMENTO: 0, VIGENTE: 0, NA: 0,
    };
    for (const g of grouped) counts[g.effectiveStatus] = g._count._all;

    const pendentes =
      counts.EM_FALTA + counts.AGUARDANDO + counts.REPROVADO + counts.VENCIDO;

    return { counts, pendentes };
  }

  /**
   * Lista todas as exigências no escopo (aba Pendentes).
   */
  async listAllRequirements(scope: AuthScope, query: ListAllRequirementsQuery) {
    const { companyId } = scope;
    const assignmentScope = assignmentScopeWhere(scope);

    const where: Prisma.WorkerRequirementItemWhereInput = {
      companyId,
      assignment: assignmentScope,
      ...(query.effectiveStatus?.length
        ? { effectiveStatus: { in: query.effectiveStatus } }
        : {}),
      ...(query.contractorId
        ? { assignment: { ...assignmentScope, contractorId: query.contractorId } }
        : {}),
      ...(query.workerId ? { workerId: query.workerId } : {}),
      ...(query.assignmentId ? { assignmentId: query.assignmentId } : {}),
    };

    const [total, items] = await Promise.all([
      prisma.workerRequirementItem.count({ where }),
      prisma.workerRequirementItem.findMany({
        where,
        include: {
          worker: {
            select: {
              id: true,
              fullName: true,
            },
          },
          assignment: {
            select: {
              id: true,
              role: true,
              contractor: { select: { id: true, name: true } },
              obra: { select: { id: true, name: true } },
            },
          },
          latestDocument: {
            select: {
              id: true,
              status: true,
              title: true,
              type: true,
              fileUrl: true,
              issuedAt: true,
              expiresAt: true,
              reviewedAt: true,
              rejectionReason: true,
            },
          },
        },
        orderBy: [{ effectiveStatus: "asc" }, { updatedAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async listRequirements(scope: AuthScope, workerId: string, assignmentId?: string) {
    const companyId = scope.companyId;
    await this.findById(scope, workerId);
    return prisma.workerRequirementItem.findMany({
      where: {
        companyId,
        workerId,
        ...(assignmentId ? { assignmentId } : {}),
      },
      include: {
        requirement: {
          select: {
            id: true,
            name: true,
            documentType: true,
            frequency: true,
            monthlyDueDay: true,
            referenceDate: true,
          },
        },
        assignment: {
          select: { id: true, obraId: true, obra: { select: { id: true, name: true } } },
        },
        latestDocument: {
          select: {
            id: true,
            status: true,
            title: true,
            type: true,
            fileUrl: true,
            issuedAt: true,
            expiresAt: true,
            reviewedAt: true,
            rejectionReason: true,
            uploadedById: true,
            uploadedBy: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
  }

  async addManualRequirement(
    scope: AuthScope,
    workerId: string,
    data: AddManualWorkerRequirementInput,
    createdById?: string,
  ) {
    const companyId = scope.companyId;
    await this.findById(scope, workerId);

    if (data.frequency === RequirementFrequency.MONTHLY && !data.monthlyDueDay) {
      throw BadRequest("Para cobrança mensal, informe `monthlyDueDay` (1-31).");
    }

    // Valida assignmentId se informado
    if (data.assignmentId) {
      const assignment = await prisma.workerAssignment.findFirst({
        where: { id: data.assignmentId, workerId, companyId },
        select: { id: true },
      });
      if (!assignment) throw NotFound("Vínculo não encontrado");
    }

    const created = await prisma.workerRequirementItem.create({
      data: {
        companyId,
        workerId,
        assignmentId: data.assignmentId,
        source: RequirementSource.MANUAL,
        status: RequirementCollectionStatus.NOT_SENT,
        name: data.name,
        documentType: data.documentType,
        frequency: data.frequency,
        monthlyDueDay: data.monthlyDueDay,
        referenceDate: data.referenceDate,
        createdById,
      },
    });
    await recomputeRequirementItem(created.id);
    return created;
  }

  async setRequirementApplicability(
    scope: AuthScope,
    workerId: string,
    itemId: string,
    data: SetWorkerRequirementApplicabilityInput,
  ) {
    const companyId = scope.companyId;
    await this.findById(scope, workerId);
    const item = await prisma.workerRequirementItem.findFirst({
      where: { id: itemId, companyId, workerId },
      select: { id: true },
    });
    if (!item) throw NotFound("Exigência do colaborador não encontrada");

    if (
      data.status === RequirementCollectionStatus.NOT_APPLICABLE &&
      (!data.naReason || data.naReason.trim().length < 2)
    ) {
      throw BadRequest("Ao marcar N/A, informe `naReason`.");
    }

    const updated = await prisma.workerRequirementItem.update({
      where: { id: itemId },
      data: {
        status: data.status,
        naReason:
          data.status === RequirementCollectionStatus.NOT_APPLICABLE
            ? data.naReason?.trim()
            : null,
      },
    });
    await recomputeRequirementItem(itemId);
    return updated;
  }

  /**
   * Anonimização de dados pessoais (LGPD Art. 18 — Direito ao Apagamento).
   *
   * Substitui CPF, RG, nome, e-mail, telefone e foto por valores neutros/nulos.
   * Inativa todos os vínculos do colaborador.
   * Os registros de acesso (audit trail de entrada/saída) são mantidos para fins
   * legais e de segurança do trabalho, mas o worker fica sem dados identificáveis.
   */
  async anonymize(scope: AuthScope, id: string, requestedById: string) {
    const companyId = scope.companyId;

    const worker = await prisma.worker.findFirst({
      where: { id, companyId },
      select: { id: true, anonymizedAt: true },
    });
    if (!worker) throw NotFound("Colaborador não encontrado");
    if (worker.anonymizedAt) {
      throw Conflict("Dados deste colaborador já foram anonimizados.");
    }

    const anonymousCpfHash = hashCpf(`ANON-${id}`);

    await prisma.$transaction(async (tx) => {
      // Substitui dados identificáveis
      await tx.worker.update({
        where: { id },
        data: {
          fullName: "Colaborador Removido",
          cpf: `ANON-${id}`,
          cpfHash: anonymousCpfHash,
          rg: null,
          birthDate: null,
          email: null,
          phone: null,
          photoUrl: null,
          anonymizedAt: new Date(),
        },
      });

      // Inativa todos os vínculos com obras
      await tx.workerAssignment.updateMany({
        where: { workerId: id, companyId },
        data: { status: "INACTIVE" },
      });
    });

    return {
      success: true,
      message:
        "Dados pessoais anonimizados conforme LGPD Art. 18. " +
        "Registros de acesso mantidos para fins legais.",
    };
  }
}

export const workerService = new WorkerService();
