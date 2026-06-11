import {
  RequirementCollectionStatus,
  RequirementSource,
  RequirementTarget,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { BadRequest, NotFound } from "../../lib/errors.js";
import type {
  ContractorTypeUpsertInput,
  ListDefinitionQuery,
  RequirementDefinitionUpsertInput,
  WorkerFunctionUpsertInput,
} from "./requirements.schema.js";

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

  private async applyFunctionTemplateToWorkers(
    tx: Prisma.TransactionClient,
    companyId: string,
    functionId: string,
    requirementIds: string[],
  ) {
    const workers = await tx.worker.findMany({
      where: { companyId, functionId },
      select: { id: true },
    });
    if (!workers.length || !requirementIds.length) return;

    const defs = await tx.documentRequirementDefinition.findMany({
      where: { id: { in: requirementIds }, companyId, target: RequirementTarget.WORKER },
    });

    for (const worker of workers) {
      const existing = await tx.workerRequirementItem.findMany({
        where: {
          companyId,
          workerId: worker.id,
          source: RequirementSource.FUNCTION_TEMPLATE,
          requirementId: { in: requirementIds },
        },
        select: { requirementId: true },
      });
      const existingIds = new Set(existing.map((e) => e.requirementId));

      for (const def of defs) {
        if (existingIds.has(def.id)) continue;
        await tx.workerRequirementItem.create({
          data: {
            companyId,
            workerId: worker.id,
            requirementId: def.id,
            source: RequirementSource.FUNCTION_TEMPLATE,
            status: RequirementCollectionStatus.NOT_SENT,
            name: def.name,
            documentType: def.documentType,
            frequency: def.frequency,
            monthlyDueDay: def.monthlyDueDay ?? undefined,
            referenceDate: def.referenceDate ?? undefined,
          },
        });
      }
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
        documentType: data.documentType,
        frequency: data.frequency,
        monthlyDueDay: data.monthlyDueDay,
        referenceDate: data.referenceDate,
        active: data.active ?? true,
      },
    });
  }

  async updateDefinition(
    companyId: string,
    id: string,
    data: Partial<RequirementDefinitionUpsertInput>,
  ) {
    const existing = await prisma.documentRequirementDefinition.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) throw NotFound("Registro documental não encontrado");
    return prisma.documentRequirementDefinition.update({
      where: { id },
      data,
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
