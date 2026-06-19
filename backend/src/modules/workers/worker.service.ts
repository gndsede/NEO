import {
  DocumentOwnerType,
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
  type AuthScope,
  workerScopeWhere,
} from "../../lib/scope.js";
import { generateNeoAccessToken } from "../../utils/access-hash.js";
import { recomputeRequirementItem } from "../requirements/requirement-status.js";
import {
  importWorkerRowSchema,
  type AddManualWorkerRequirementInput,
  type CreateWorkerInput,
  type DocumentMeta,
  type ListAllRequirementsQuery,
  type ListWorkersQuery,
  type SetWorkerRequirementApplicabilityInput,
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

/**
 * Classifica o turno do colaborador para o filtro da listagem.
 * - NONE: turno não cadastrado em pelo menos uma ponta.
 * - DAY: shiftStart <= shiftEnd (turno cabe num único dia).
 * - NIGHT: shiftStart > shiftEnd (entra num dia, sai no seguinte).
 */
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
 * Pré-filtra IDs de workers que casam com a busca textual usando `unaccent`
 * do Postgres — busca parcial, em qualquer ordem, insensível a acento e
 * maiúsculas. Cada token vira um `AND ... ILIKE ...` no campo escolhido.
 *
 * Ex.: name="jose silva" pega "José da Silva Pereira".
 */
async function workerIdsMatchingText(params: {
  scopeWhere: { companyId: string; obraId?: unknown };
  filters: Array<{ field: "fullName" | "rg" | "registration" | "email"; raw: string }>;
}): Promise<string[]> {
  const { scopeWhere, filters } = params;
  const conditions: string[] = [];
  const values: string[] = [];
  let i = 1;

  for (const { field, raw } of filters) {
    for (const t of tokenize(raw)) {
      conditions.push(
        `unaccent(lower("${field}")) LIKE unaccent(lower($${i}))`,
      );
      values.push(`%${t}%`);
      i += 1;
    }
  }

  if (conditions.length === 0) return [];

  const companyParam = `$${i}`;
  values.push(scopeWhere.companyId);
  i += 1;

  let obraClause = "";
  // Filtro de obra do scope (uma única obra ou lista).
  if (scopeWhere.obraId && typeof scopeWhere.obraId === "string") {
    obraClause = ` AND "obraId" = $${i}`;
    values.push(scopeWhere.obraId);
    i += 1;
  } else if (
    scopeWhere.obraId &&
    typeof scopeWhere.obraId === "object" &&
    "in" in scopeWhere.obraId &&
    Array.isArray((scopeWhere.obraId as { in: unknown[] }).in)
  ) {
    const ids = (scopeWhere.obraId as { in: string[] }).in;
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, k) => `$${i + k}`).join(",");
    obraClause = ` AND "obraId" IN (${placeholders})`;
    values.push(...ids);
    i += ids.length;
  }

  const sql = `SELECT id FROM "workers"
    WHERE "companyId" = ${companyParam}${obraClause}
      AND ${conditions.join(" AND ")}`;

  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...values);
  return rows.map((r) => r.id);
}

/**
 * Busca global (campo único): cada token precisa aparecer em pelo menos um
 * de {fullName, registration, qrHash, cpf}. Insensível a acento e caixa.
 */
async function workerIdsMatchingGlobal(params: {
  scopeWhere: { companyId: string; obraId?: unknown };
  raw: string;
}): Promise<string[]> {
  const tokens = tokenize(params.raw);
  if (tokens.length === 0) return [];

  const values: string[] = [];
  let i = 1;
  const perTokenAnds: string[] = [];

  for (const t of tokens) {
    const tokenOr: string[] = [];
    tokenOr.push(
      `unaccent(lower("fullName")) LIKE unaccent(lower($${i}))`,
    );
    values.push(`%${t}%`);
    i += 1;

    tokenOr.push(
      `unaccent(lower(coalesce("registration", ''))) LIKE unaccent(lower($${i}))`,
    );
    values.push(`%${t}%`);
    i += 1;

    tokenOr.push(`lower("qrHash") LIKE lower($${i})`);
    values.push(`%${t}%`);
    i += 1;

    const digits = t.replace(/\D/g, "");
    if (digits.length > 0) {
      tokenOr.push(`"cpf" LIKE $${i}`);
      values.push(`%${digits}%`);
      i += 1;
    }
    perTokenAnds.push(`(${tokenOr.join(" OR ")})`);
  }

  const companyParam = `$${i}`;
  values.push(params.scopeWhere.companyId);
  i += 1;

  let obraClause = "";
  if (params.scopeWhere.obraId && typeof params.scopeWhere.obraId === "string") {
    obraClause = ` AND "obraId" = $${i}`;
    values.push(params.scopeWhere.obraId);
    i += 1;
  } else if (
    params.scopeWhere.obraId &&
    typeof params.scopeWhere.obraId === "object" &&
    "in" in params.scopeWhere.obraId &&
    Array.isArray((params.scopeWhere.obraId as { in: unknown[] }).in)
  ) {
    const ids = (params.scopeWhere.obraId as { in: string[] }).in;
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, k) => `$${i + k}`).join(",");
    obraClause = ` AND "obraId" IN (${placeholders})`;
    values.push(...ids);
    i += ids.length;
  }

  const sql = `SELECT id FROM "workers"
    WHERE "companyId" = ${companyParam}${obraClause}
      AND ${perTokenAnds.join(" AND ")}`;
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...values);
  return rows.map((r) => r.id);
}

export class WorkerService {
  private async generateUniqueAccessToken(): Promise<string> {
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
    if (!fn) {
      throw NotFound("Função de colaborador não encontrada para esta empresa");
    }
  }

  private async syncWorkerRequirementsFromFunction(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      workerId: string;
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
        workerId: params.workerId,
        source: RequirementSource.FUNCTION_TEMPLATE,
        requirementId: { not: null },
      },
      select: { id: true, requirementId: true },
    });
    const existingRequirementIds = new Set(existing.map((item) => item.requirementId));

    for (const rel of defs) {
      if (existingRequirementIds.has(rel.requirementId)) continue;
      await tx.workerRequirementItem.create({
        data: {
          companyId: params.companyId,
          workerId: params.workerId,
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
   * 1. valida empreiteira pertencente ao tenant;
   * 2. faz upload da foto e dos documentos no storage;
   * 3. persiste Worker + Documents (status PENDENTE) em uma transação.
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

    const duplicate = await prisma.worker.findUnique({
      where: { obraId_cpf: { obraId: contractor.obraId, cpf: data.cpf } },
      select: { id: true },
    });
    if (duplicate) {
      throw Conflict("Já existe um colaborador com este CPF nesta obra");
    }

    if (data.functionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, data.functionId);
    }

    const docsMeta = data.documentsMeta ?? [];
    if (documents && documents.length !== docsMeta.length) {
      throw BadRequest(
        `Quantidade de arquivos (${documents.length}) difere dos metadados em documentsMeta (${docsMeta.length}).`,
      );
    }

    const storage = await getStorage();
    const qrHash = await this.generateUniqueAccessToken();

    // Upload da foto (fora da transação — I/O externo).
    let photoUrl: string | undefined;
    if (photo) {
      const stored = await storage.upload({
        buffer: photo.buffer,
        originalName: photo.originalname,
        mimeType: photo.mimetype,
        folder: `companies/${companyId}/workers/photos`,
      });
      photoUrl = stored.url;
    }

    // Upload dos documentos.
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
      const created = await tx.worker.create({
        data: {
          companyId,
          obraId: contractor.obraId,
          contractorId: data.contractorId,
          functionId: data.functionId,
          fullName: data.fullName,
          cpf: data.cpf,
          rg: data.rg,
          birthDate: data.birthDate,
          email: data.email,
          phone: data.phone,
          role: data.role,
          registration: data.registration,
          shiftStart: data.shiftStart,
          shiftEnd: data.shiftEnd,
          photoUrl,
          qrHash,
        },
      });

      if (uploadedDocs.length > 0) {
        await tx.document.createMany({
          data: uploadedDocs.map(({ file, meta, stored }) => ({
            companyId,
            ownerType: DocumentOwnerType.WORKER,
            workerId: created.id,
            type: meta.type,
            title: meta.title,
            fileUrl: stored.url,
            fileKey: stored.key,
            mimeType: file.mimetype,
            fileSize: file.size,
            issuedAt: meta.issuedAt,
            expiresAt: meta.expiresAt,
            uploadedById: createdById,
          })),
        });
      }

      if (data.functionId) {
        await this.syncWorkerRequirementsFromFunction(tx, {
          companyId,
          workerId: created.id,
          functionId: data.functionId,
          createdById,
        });
      }

      return tx.worker.findUniqueOrThrow({
        where: { id: created.id },
        include: { documents: true, contractor: true, function: true, requirementItems: true },
      });
    });

    return worker;
  }

  /**
   * Importação em lote a partir de linhas de planilha. Resolve empreiteira e
   * função por nome (case-insensitive), cria a função se não existir e ignora
   * linhas inválidas/duplicadas retornando um relatório por linha.
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

        const duplicate = await prisma.worker.findUnique({
          where: { obraId_cpf: { obraId: contractor.obraId, cpf: data.cpf } },
          select: { id: true },
        });
        if (duplicate) {
          results.push({
            line,
            status: "error",
            message: "CPF já cadastrado",
            fullName: data.fullName,
          });
          continue;
        }

        let functionId: string | undefined;
        if (data.functionName) {
          const fn = await prisma.workerFunction.upsert({
            where: {
              companyId_name: { companyId, name: data.functionName },
            },
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
      include: {
        documents: true,
        contractor: true,
        function: true,
        requirementItems: true,
        obra: { select: { id: true, name: true } },
      },
    });
    if (!worker) throw NotFound("Colaborador não encontrado");
    return worker;
  }

  async list(scope: AuthScope, query: ListWorkersQuery) {
    const cpfDigits = query.cpf?.replace(/\D/g, "") || undefined;
    const baseScope = workerScopeWhere(scope);

    // Pré-filtra IDs por texto (nome/RG/matrícula/email) usando unaccent.
    const textFilters: Array<{ field: "fullName" | "rg" | "registration" | "email"; raw: string }> = [];
    if (query.name) textFilters.push({ field: "fullName", raw: query.name });
    if (query.rg) textFilters.push({ field: "rg", raw: query.rg });
    if (query.registration)
      textFilters.push({ field: "registration", raw: query.registration });
    if (query.email) textFilters.push({ field: "email", raw: query.email });

    let textIds: string[] | null = null;
    if (textFilters.length > 0) {
      textIds = await workerIdsMatchingText({
        scopeWhere: {
          companyId: scope.companyId,
          obraId: (baseScope as { obraId?: unknown }).obraId,
        },
        filters: textFilters,
      });
      if (textIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
    }

    // Busca global (campo único): pré-filtra IDs por OR sobre nome/matrícula/QR
    // e mais um EQUAL no CPF/dígitos.
    if (query.search) {
      const globalIds = await workerIdsMatchingGlobal({
        scopeWhere: {
          companyId: scope.companyId,
          obraId: (baseScope as { obraId?: unknown }).obraId,
        },
        raw: query.search,
      });
      if (globalIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
      textIds =
        textIds === null
          ? globalIds
          : textIds.filter((id) => globalIds.includes(id));
      if (textIds.length === 0) {
        return {
          items: [],
          pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 },
        };
      }
    }

    const where: Prisma.WorkerWhereInput = {
      ...baseScope,
      ...(query.contractorId ? { contractorId: query.contractorId } : {}),
      ...(query.functionId ? { functionId: query.functionId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(cpfDigits ? { cpf: { contains: cpfDigits } } : {}),
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
            requirementItems: {
              some: { effectiveStatus: { in: query.effectiveStatus } },
            },
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.worker.count({ where }),
      prisma.worker.findMany({
        where,
        include: {
          contractor: { select: { id: true, name: true } },
          obra: { select: { id: true, name: true } },
          // Apenas o status efetivo é necessário no front (chips/filtros).
          requirementItems: { select: { effectiveStatus: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    // Filtro de turno é feito em memória — comparar duas colunas string da
    // mesma linha no Prisma exigiria raw SQL; o pós-filtro é simples e barato
    // dentro do pageSize (máx. 1000).
    const filteredItems = query.shift
      ? items.filter((w) => matchesShift(w.shiftStart, w.shiftEnd, query.shift!))
      : items;

    return {
      items: filteredItems,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async update(scope: AuthScope, id: string, data: UpdateWorkerInput) {
    const companyId = scope.companyId;
    const existing = await this.findById(scope, id);

    const nextFunctionId =
      data.functionId === undefined ? existing.functionId : data.functionId;
    if (nextFunctionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, nextFunctionId);
    }

    // Quando o contractorId muda, busca a obra da nova empreiteira para
    // manter worker.obraId em sincronia (worker pertence à obra do seu contractor).
    let newObraId: string | undefined;
    if (data.contractorId && data.contractorId !== existing.contractorId) {
      const contractor = await prisma.contractor.findFirst({
        where: { id: data.contractorId, companyId },
        select: { id: true, obraId: true },
      });
      if (!contractor) throw NotFound("Empreiteira não encontrada");
      newObraId = contractor.obraId;
    }

    const worker = await prisma.$transaction(async (tx) => {
      const updated = await tx.worker.update({
        where: { id },
        data: {
          ...data,
          ...(newObraId ? { obraId: newObraId } : {}),
        },
        include: {
          documents: true,
          contractor: true,
          function: true,
          requirementItems: true,
        },
      });

      if (nextFunctionId) {
        await this.syncWorkerRequirementsFromFunction(tx, {
          companyId,
          workerId: id,
          functionId: nextFunctionId,
        });
      }

      return updated;
    });

    return worker;
  }

  /** Atualiza apenas a foto do colaborador (upload no storage). */
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
    return prisma.worker.update({
      where: { id },
      data: { photoUrl: stored.url },
      include: { documents: true, contractor: true, function: true, requirementItems: true },
    });
  }

  /**
   * Contadores do "funil" — quantas exigências há em cada situação efetiva,
   * dentro do escopo (obra) do usuário. Alimenta os indicadores e a navegação
   * por situação. Uma única query agregada (groupBy), escala com 1000+.
   */
  async requirementsSummary(scope: AuthScope) {
    const grouped = await prisma.workerRequirementItem.groupBy({
      by: ["effectiveStatus"],
      where: { companyId: scope.companyId, worker: workerScopeWhere(scope) },
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      EM_FALTA: 0,
      AGUARDANDO: 0,
      REPROVADO: 0,
      VENCIDO: 0,
      PROX_VENCIMENTO: 0,
      VIGENTE: 0,
      NA: 0,
    };
    for (const g of grouped) counts[g.effectiveStatus] = g._count._all;

    const pendentes =
      counts.EM_FALTA + counts.AGUARDANDO + counts.REPROVADO + counts.VENCIDO;

    return { counts, pendentes };
  }

  /**
   * Lista todas as exigências de todos os colaboradores no escopo,
   * com filtros por effectiveStatus, contractorId e workerId.
   * Alimenta a aba Pendentes do portal.
   */
  async listAllRequirements(scope: AuthScope, query: ListAllRequirementsQuery) {
    const { companyId } = scope;
    const scopeWhere = workerScopeWhere(scope);

    const where = {
      companyId,
      worker: scopeWhere,
      ...(query.effectiveStatus?.length
        ? { effectiveStatus: { in: query.effectiveStatus } }
        : {}),
      ...(query.contractorId
        ? { worker: { ...scopeWhere, contractorId: query.contractorId } }
        : {}),
      ...(query.workerId ? { workerId: query.workerId } : {}),
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

  async listRequirements(scope: AuthScope, workerId: string) {
    const companyId = scope.companyId;
    await this.findById(scope, workerId);
    return prisma.workerRequirementItem.findMany({
      where: { companyId, workerId },
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

    const created = await prisma.workerRequirementItem.create({
      data: {
        companyId,
        workerId,
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
}

export const workerService = new WorkerService();
