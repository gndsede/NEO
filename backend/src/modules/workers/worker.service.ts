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
            documentsMeta: [],
          } as CreateWorkerInput,
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
    const where: Prisma.WorkerWhereInput = {
      ...workerScopeWhere(scope),
      ...(query.contractorId ? { contractorId: query.contractorId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: "insensitive" } },
              { cpf: { contains: query.search.replace(/\D/g, "") } },
              { registration: { contains: query.search, mode: "insensitive" } },
              { qrHash: { contains: query.search.toUpperCase(), mode: "insensitive" } },
            ],
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
        },
        orderBy: { createdAt: "desc" },
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

  async update(scope: AuthScope, id: string, data: UpdateWorkerInput) {
    const companyId = scope.companyId;
    const existing = await this.findById(scope, id);

    const nextFunctionId =
      data.functionId === undefined ? existing.functionId : data.functionId;
    if (nextFunctionId) {
      await this.ensureWorkerFunctionBelongsToCompany(companyId, nextFunctionId);
    }

    const worker = await prisma.$transaction(async (tx) => {
      const updated = await tx.worker.update({
        where: { id },
        data,
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
