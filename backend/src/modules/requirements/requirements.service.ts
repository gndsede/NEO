import {
  LifecyclePhase,
  RequirementCollectionStatus,
  RequirementSource,
  RequirementTarget,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { BadRequest, NotFound } from "../../lib/errors.js";
import {
  materializeRequirementsForPhases,
  phasesToMaterialize,
} from "./lifecycle.js";
import {
  importDefinitionRowSchema,
  importNameDescRowSchema,
  type ContractorTypeUpsertInput,
  type ListDefinitionQuery,
  type RequirementDefinitionUpsertInput,
  type WorkerFunctionUpsertInput,
} from "./requirements.schema.js";

type ImportRowResult = {
  line: number;
  status: "created" | "error";
  message?: string;
  name?: string;
};
type ImportBatchResult = {
  created: number;
  total: number;
  results: ImportRowResult[];
};

/**
 * Fase só faz sentido para exigência de colaborador — fornecedor não tem ciclo
 * de admissão/desligamento. Lista vazia cairia num registro que nunca é
 * cobrado, então o padrão é ATIVIDADE.
 */
function normalizePhases(
  target: RequirementTarget,
  phases?: LifecyclePhase[] | null,
): LifecyclePhase[] {
  if (target !== RequirementTarget.WORKER) return [LifecyclePhase.ATIVIDADE];
  if (!phases || phases.length === 0) return [LifecyclePhase.ATIVIDADE];
  return [...new Set(phases)];
}

export class RequirementsService {
  private async validateRequirementIds(
    tx: Prisma.TransactionClient,
    companyId: string,
    target: RequirementTarget,
    ids: string[],
  ) {
    if (ids.length === 0) return [];
    const defs = await tx.documentRequirementDefinition.findMany({
      where: { companyId, target, id: { in: ids }, active: true },
      select: { id: true },
    });
    if (defs.length !== ids.length) {
      throw BadRequest(
        "Uma ou mais exigências não existem para este tenant/target ou estão inativas.",
      );
    }
    return defs.map((d) => d.id);
  }

  /**
   * Propaga uma mudança no template da função para os vínculos que já a usam.
   * Cada vínculo só recebe as exigências das fases que ele já alcançou — quem
   * está em atividade não volta a dever documento de admissão.
   */
  private async applyFunctionTemplateToWorkers(
    tx: Prisma.TransactionClient,
    companyId: string,
    functionId: string,
    requirementIds: string[],
  ) {
    if (!requirementIds.length) return;
    // `functionId` vive em WorkerAssignment (vínculo por obra), não em Worker.
    const assignments = await tx.workerAssignment.findMany({
      where: { companyId, functionId },
      select: { id: true, workerId: true, phase: true },
    });

    for (const assignment of assignments) {
      await materializeRequirementsForPhases(tx, {
        companyId,
        workerId: assignment.workerId,
        assignmentId: assignment.id,
        functionId,
        phases: phasesToMaterialize(assignment.phase),
      });
    }
  }

  async syncContractorRequirementsForType(
    tx: Prisma.TransactionClient,
    params: {
      companyId: string;
      contractorId: string;
      contractorTypeId: string;
      createdById?: string;
    },
  ) {
    const defs = await tx.contractorTypeRequirement.findMany({
      where: {
        contractorTypeId: params.contractorTypeId,
        required: true,
        requirement: {
          companyId: params.companyId,
          active: true,
          target: RequirementTarget.CONTRACTOR,
        },
      },
      include: { requirement: true },
    });

    const existing = await tx.contractorRequirementItem.findMany({
      where: {
        companyId: params.companyId,
        contractorId: params.contractorId,
        source: RequirementSource.CONTRACTOR_TYPE_TEMPLATE,
        requirementId: { not: null },
      },
      select: { requirementId: true },
    });
    const existingIds = new Set(existing.map((e) => e.requirementId));

    for (const rel of defs) {
      if (existingIds.has(rel.requirementId)) continue;
      await tx.contractorRequirementItem.create({
        data: {
          companyId: params.companyId,
          contractorId: params.contractorId,
          requirementId: rel.requirementId,
          source: RequirementSource.CONTRACTOR_TYPE_TEMPLATE,
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

  async listDefinitions(companyId: string, query: ListDefinitionQuery) {
    return prisma.documentRequirementDefinition.findMany({
      where: {
        companyId,
        ...(query.target ? { target: query.target } : {}),
        ...(query.active === undefined ? {} : { active: query.active }),
      },
      orderBy: [{ target: "asc" }, { name: "asc" }],
    });
  }

  async createDefinition(companyId: string, data: RequirementDefinitionUpsertInput) {
    return prisma.documentRequirementDefinition.create({
      data: {
        companyId,
        target: data.target,
        name: data.name,
        description: data.description,
        documentType: data.documentType,
        frequency: data.frequency,
        monthlyDueDay: data.monthlyDueDay,
        referenceDate: data.referenceDate,
        phases: normalizePhases(data.target, data.phases),
        attachmentFormats: data.attachmentFormats,
        attachmentRequired: data.attachmentRequired ?? true,
        competenceMode: data.competenceMode ?? "NONE",
        observations: data.observations,
        grantsTurnstileAccess: data.grantsTurnstileAccess ?? false,
        active: data.active ?? true,
      },
    });
  }

  /** Retorna grupos e usuários com acesso concedido a um registro específico. */
  async getDefinitionAccess(companyId: string, definitionId: string) {
    const definition = await prisma.documentRequirementDefinition.findFirst({
      where: { id: definitionId, companyId },
      select: { id: true },
    });
    if (!definition) throw NotFound("Registro documental não encontrado");

    const [groupAccess, userAccess] = await Promise.all([
      prisma.requirementDefinitionGroupAccess.findMany({
        where: { requirementId: definitionId },
        select: { groupId: true },
      }),
      prisma.requirementDefinitionUserAccess.findMany({
        where: { requirementId: definitionId },
        select: { userId: true },
      }),
    ]);

    return {
      groupIds: groupAccess.map((g) => g.groupId),
      userIds: userAccess.map((u) => u.userId),
    };
  }

  /** Substitui a lista de grupos/usuários com acesso a um registro específico. */
  async setDefinitionAccess(
    companyId: string,
    definitionId: string,
    data: { groupIds: string[]; userIds: string[] },
  ) {
    const definition = await prisma.documentRequirementDefinition.findFirst({
      where: { id: definitionId, companyId },
      select: { id: true },
    });
    if (!definition) throw NotFound("Registro documental não encontrado");

    if (data.groupIds.length) {
      const validGroups = await prisma.userGroup.findMany({
        where: { id: { in: data.groupIds }, companyId },
        select: { id: true },
      });
      if (validGroups.length !== data.groupIds.length) {
        throw NotFound("Um ou mais grupos informados não existem.");
      }
    }
    if (data.userIds.length) {
      const validUsers = await prisma.user.findMany({
        where: { id: { in: data.userIds }, companyId },
        select: { id: true },
      });
      if (validUsers.length !== data.userIds.length) {
        throw NotFound("Um ou mais usuários informados não existem.");
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.requirementDefinitionGroupAccess.deleteMany({
        where: { requirementId: definitionId },
      });
      if (data.groupIds.length) {
        await tx.requirementDefinitionGroupAccess.createMany({
          data: data.groupIds.map((groupId) => ({ requirementId: definitionId, groupId })),
        });
      }
      await tx.requirementDefinitionUserAccess.deleteMany({
        where: { requirementId: definitionId },
      });
      if (data.userIds.length) {
        await tx.requirementDefinitionUserAccess.createMany({
          data: data.userIds.map((userId) => ({ requirementId: definitionId, userId })),
        });
      }
    });

    return this.getDefinitionAccess(companyId, definitionId);
  }

  async updateDefinition(
    companyId: string,
    id: string,
    data: Partial<RequirementDefinitionUpsertInput>,
  ) {
    const existing = await prisma.documentRequirementDefinition.findFirst({
      where: { id, companyId },
      select: { id: true, target: true, phases: true },
    });
    if (!existing) throw NotFound("Registro documental não encontrado");
    const target = data.target ?? existing.target;
    return prisma.documentRequirementDefinition.update({
      where: { id },
      data: {
        ...data,
        ...(data.phases !== undefined || data.target !== undefined
          ? { phases: normalizePhases(target, data.phases ?? existing.phases) }
          : {}),
      },
    });
  }

  async listWorkerFunctions(companyId: string) {
    return prisma.workerFunction.findMany({
      where: { companyId },
      include: {
        requirements: {
          include: { requirement: true },
        },
      },
      orderBy: { name: "asc" },
    });
  }

  async createWorkerFunction(companyId: string, data: WorkerFunctionUpsertInput) {
    return prisma.$transaction(async (tx) => {
      const fn = await tx.workerFunction.create({
        data: {
          companyId,
          name: data.name,
          description: data.description,
          active: data.active ?? true,
        },
      });
      const requirementIds = await this.validateRequirementIds(
        tx,
        companyId,
        RequirementTarget.WORKER,
        data.requirementIds ?? [],
      );
      if (requirementIds.length) {
        await tx.workerFunctionRequirement.createMany({
          data: requirementIds.map((rid) => ({
            functionId: fn.id,
            requirementId: rid,
            required: true,
          })),
        });
        await this.applyFunctionTemplateToWorkers(
          tx,
          companyId,
          fn.id,
          requirementIds,
        );
      }
      return tx.workerFunction.findUniqueOrThrow({
        where: { id: fn.id },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }

  async updateWorkerFunction(
    companyId: string,
    id: string,
    data: Partial<WorkerFunctionUpsertInput>,
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.workerFunction.findFirst({
        where: { id, companyId },
        select: { id: true },
      });
      if (!existing) throw NotFound("Função não encontrada");

      await tx.workerFunction.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
      });

      if (data.requirementIds) {
        const requirementIds = await this.validateRequirementIds(
          tx,
          companyId,
          RequirementTarget.WORKER,
          data.requirementIds,
        );
        await tx.workerFunctionRequirement.deleteMany({ where: { functionId: id } });
        if (requirementIds.length) {
          await tx.workerFunctionRequirement.createMany({
            data: requirementIds.map((rid) => ({
              functionId: id,
              requirementId: rid,
              required: true,
            })),
          });
          await this.applyFunctionTemplateToWorkers(
            tx,
            companyId,
            id,
            requirementIds,
          );
        }
      }

      return tx.workerFunction.findUniqueOrThrow({
        where: { id },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }

  async listContractorTypes(companyId: string) {
    return prisma.contractorType.findMany({
      where: { companyId },
      include: {
        requirements: {
          include: { requirement: true },
        },
      },
      orderBy: { name: "asc" },
    });
  }

  async createContractorType(
    companyId: string,
    data: ContractorTypeUpsertInput,
  ) {
    return prisma.$transaction(async (tx) => {
      const type = await tx.contractorType.create({
        data: {
          companyId,
          name: data.name,
          description: data.description,
          active: data.active ?? true,
        },
      });
      const requirementIds = await this.validateRequirementIds(
        tx,
        companyId,
        RequirementTarget.CONTRACTOR,
        data.requirementIds ?? [],
      );
      if (requirementIds.length) {
        await tx.contractorTypeRequirement.createMany({
          data: requirementIds.map((rid) => ({
            contractorTypeId: type.id,
            requirementId: rid,
            required: true,
          })),
        });
      }
      return tx.contractorType.findUniqueOrThrow({
        where: { id: type.id },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }

  async updateContractorType(
    companyId: string,
    id: string,
    data: Partial<ContractorTypeUpsertInput>,
  ) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.contractorType.findFirst({
        where: { id, companyId },
        select: { id: true },
      });
      if (!existing) throw NotFound("Tipo de fornecedor não encontrado");

      await tx.contractorType.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.active !== undefined ? { active: data.active } : {}),
        },
      });

      if (data.requirementIds) {
        const requirementIds = await this.validateRequirementIds(
          tx,
          companyId,
          RequirementTarget.CONTRACTOR,
          data.requirementIds,
        );
        await tx.contractorTypeRequirement.deleteMany({
          where: { contractorTypeId: id },
        });
        if (requirementIds.length) {
          await tx.contractorTypeRequirement.createMany({
            data: requirementIds.map((rid) => ({
              contractorTypeId: id,
              requirementId: rid,
              required: true,
            })),
          });
        }

        const contractors = await tx.contractor.findMany({
          where: { companyId, typeId: id },
          select: { id: true },
        });
        for (const contractor of contractors) {
          await this.syncContractorRequirementsForType(tx, {
            companyId,
            contractorId: contractor.id,
            contractorTypeId: id,
          });
        }
      }

      return tx.contractorType.findUniqueOrThrow({
        where: { id },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }

  /**
   * Importação em lote de funções de colaborador a partir de linhas de
   * planilha (nome + descrição). Ignora linhas inválidas/duplicadas
   * retornando um relatório por linha.
   */
  async importWorkerFunctions(
    companyId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<ImportBatchResult> {
    const results: ImportRowResult[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = i + 1;
      const parsed = importNameDescRowSchema.safeParse(rows[i]);
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
        const existing = await prisma.workerFunction.findFirst({
          where: { companyId, name: { equals: data.name, mode: "insensitive" } },
          select: { id: true },
        });
        if (existing) {
          results.push({
            line,
            status: "error",
            message: "Função já cadastrada com este nome",
            name: data.name,
          });
          continue;
        }
        await prisma.workerFunction.create({
          data: { companyId, name: data.name, description: data.description },
        });
        created += 1;
        results.push({ line, status: "created", name: data.name });
      } catch (err) {
        results.push({
          line,
          status: "error",
          message: err instanceof Error ? err.message : "Erro desconhecido",
          name: data.name,
        });
      }
    }
    return { created, total: rows.length, results };
  }

  /**
   * Importação em lote de tipos de fornecedor a partir de linhas de
   * planilha (nome + descrição). Ignora linhas inválidas/duplicadas
   * retornando um relatório por linha.
   */
  async importContractorTypes(
    companyId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<ImportBatchResult> {
    const results: ImportRowResult[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = i + 1;
      const parsed = importNameDescRowSchema.safeParse(rows[i]);
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
        const existing = await prisma.contractorType.findFirst({
          where: { companyId, name: { equals: data.name, mode: "insensitive" } },
          select: { id: true },
        });
        if (existing) {
          results.push({
            line,
            status: "error",
            message: "Tipo já cadastrado com este nome",
            name: data.name,
          });
          continue;
        }
        await prisma.contractorType.create({
          data: { companyId, name: data.name, description: data.description },
        });
        created += 1;
        results.push({ line, status: "created", name: data.name });
      } catch (err) {
        results.push({
          line,
          status: "error",
          message: err instanceof Error ? err.message : "Erro desconhecido",
          name: data.name,
        });
      }
    }
    return { created, total: rows.length, results };
  }

  /**
   * Importação em lote de registros documentais (RequirementDefinition) a
   * partir de linhas de planilha. Ignora linhas inválidas/duplicadas
   * retornando um relatório por linha.
   */
  async importDefinitions(
    companyId: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<ImportBatchResult> {
    const results: ImportRowResult[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = i + 1;
      const parsed = importDefinitionRowSchema.safeParse(rows[i]);
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
        const existing = await prisma.documentRequirementDefinition.findFirst({
          where: {
            companyId,
            target: data.target as RequirementTarget,
            name: { equals: data.name, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (existing) {
          results.push({
            line,
            status: "error",
            message: "Registro já cadastrado com este nome para este alvo",
            name: data.name,
          });
          continue;
        }
        await prisma.documentRequirementDefinition.create({
          data: {
            companyId,
            target: data.target as RequirementTarget,
            name: data.name,
            documentType: data.documentType,
            frequency: data.frequency,
            monthlyDueDay: data.monthlyDueDay,
            referenceDate: data.referenceDate,
            phases: normalizePhases(data.target as RequirementTarget, data.phases),
            active: true,
          },
        });
        created += 1;
        results.push({ line, status: "created", name: data.name });
      } catch (err) {
        results.push({
          line,
          status: "error",
          message: err instanceof Error ? err.message : "Erro desconhecido",
          name: data.name,
        });
      }
    }
    return { created, total: rows.length, results };
  }

  async copyWorkerFunctionRequirements(
    companyId: string,
    sourceId: string,
    targetId: string,
    mode: "merge" | "replace" = "merge",
  ) {
    if (sourceId === targetId) {
      throw BadRequest("A função de origem e destino devem ser diferentes.");
    }

    return prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.workerFunction.findFirst({
          where: { id: sourceId, companyId },
          include: {
            requirements: { where: { required: true }, select: { requirementId: true } },
          },
        }),
        tx.workerFunction.findFirst({
          where: { id: targetId, companyId },
          select: { id: true },
        }),
      ]);

      if (!source) throw NotFound("Função de origem não encontrada");
      if (!target) throw NotFound("Função de destino não encontrada");

      const sourceIds = source.requirements.map((r) => r.requirementId);
      let finalIds: string[];

      if (mode === "replace") {
        finalIds = sourceIds;
      } else {
        const targetReqs = await tx.workerFunctionRequirement.findMany({
          where: { functionId: targetId, required: true },
          select: { requirementId: true },
        });
        const merged = new Set([
          ...targetReqs.map((r) => r.requirementId),
          ...sourceIds,
        ]);
        finalIds = [...merged];
      }

      const requirementIds = await this.validateRequirementIds(
        tx,
        companyId,
        RequirementTarget.WORKER,
        finalIds,
      );

      await tx.workerFunctionRequirement.deleteMany({ where: { functionId: targetId } });
      if (requirementIds.length) {
        await tx.workerFunctionRequirement.createMany({
          data: requirementIds.map((rid) => ({
            functionId: targetId,
            requirementId: rid,
            required: true,
          })),
        });
        await this.applyFunctionTemplateToWorkers(
          tx,
          companyId,
          targetId,
          requirementIds,
        );
      }

      return tx.workerFunction.findUniqueOrThrow({
        where: { id: targetId },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }

  async copyContractorTypeRequirements(
    companyId: string,
    sourceId: string,
    targetId: string,
    mode: "merge" | "replace" = "merge",
  ) {
    if (sourceId === targetId) {
      throw BadRequest("O tipo de origem e destino devem ser diferentes.");
    }

    return prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.contractorType.findFirst({
          where: { id: sourceId, companyId },
          include: {
            requirements: { where: { required: true }, select: { requirementId: true } },
          },
        }),
        tx.contractorType.findFirst({
          where: { id: targetId, companyId },
          select: { id: true },
        }),
      ]);

      if (!source) throw NotFound("Tipo de fornecedor de origem não encontrado");
      if (!target) throw NotFound("Tipo de fornecedor de destino não encontrado");

      const sourceIds = source.requirements.map((r) => r.requirementId);
      let finalIds: string[];

      if (mode === "replace") {
        finalIds = sourceIds;
      } else {
        const targetReqs = await tx.contractorTypeRequirement.findMany({
          where: { contractorTypeId: targetId, required: true },
          select: { requirementId: true },
        });
        const merged = new Set([
          ...targetReqs.map((r) => r.requirementId),
          ...sourceIds,
        ]);
        finalIds = [...merged];
      }

      const requirementIds = await this.validateRequirementIds(
        tx,
        companyId,
        RequirementTarget.CONTRACTOR,
        finalIds,
      );

      await tx.contractorTypeRequirement.deleteMany({
        where: { contractorTypeId: targetId },
      });
      if (requirementIds.length) {
        await tx.contractorTypeRequirement.createMany({
          data: requirementIds.map((rid) => ({
            contractorTypeId: targetId,
            requirementId: rid,
            required: true,
          })),
        });
      }

      const contractors = await tx.contractor.findMany({
        where: { companyId, typeId: targetId },
        select: { id: true },
      });
      for (const contractor of contractors) {
        await this.syncContractorRequirementsForType(tx, {
          companyId,
          contractorId: contractor.id,
          contractorTypeId: targetId,
        });
      }

      return tx.contractorType.findUniqueOrThrow({
        where: { id: targetId },
        include: { requirements: { include: { requirement: true } } },
      });
    });
  }
}

export const requirementsService = new RequirementsService();
