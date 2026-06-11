import type { Request, Response } from "express";
import { Unauthorized } from "../../lib/errors.js";
import { requirementsService } from "./requirements.service.js";
import {
  contractorTypeUpsertSchema,
  copyRequirementsSchema,
  listDefinitionQuerySchema,
  requirementDefinitionUpsertSchema,
  workerFunctionUpsertSchema,
} from "./requirements.schema.js";

function companyIdFrom(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

export const requirementsController = {
  async listDefinitions(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const query = listDefinitionQuerySchema.parse(req.query);
    const items = await requirementsService.listDefinitions(companyId, query);
    res.json({ items });
  },

  async createDefinition(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = requirementDefinitionUpsertSchema.parse(req.body);
    const item = await requirementsService.createDefinition(companyId, data);
    res.status(201).json(item);
  },

  async updateDefinition(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = requirementDefinitionUpsertSchema.partial().parse(req.body);
    const item = await requirementsService.updateDefinition(
      companyId,
      String(req.params.id),
      data,
    );
    res.json(item);
  },

  async listWorkerFunctions(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const items = await requirementsService.listWorkerFunctions(companyId);
    res.json({ items });
  },

  async createWorkerFunction(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = workerFunctionUpsertSchema.parse(req.body);
    const item = await requirementsService.createWorkerFunction(companyId, data);
    res.status(201).json(item);
  },

  async updateWorkerFunction(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = workerFunctionUpsertSchema.partial().parse(req.body);
    const item = await requirementsService.updateWorkerFunction(
      companyId,
      String(req.params.id),
      data,
    );
    res.json(item);
  },

  async listContractorTypes(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const items = await requirementsService.listContractorTypes(companyId);
    res.json({ items });
  },

  async createContractorType(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = contractorTypeUpsertSchema.parse(req.body);
    const item = await requirementsService.createContractorType(companyId, data);
    res.status(201).json(item);
  },

  async updateContractorType(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = contractorTypeUpsertSchema.partial().parse(req.body);
    const item = await requirementsService.updateContractorType(
      companyId,
      String(req.params.id),
      data,
    );
    res.json(item);
  },

  async copyWorkerFunctionRequirements(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = copyRequirementsSchema.parse(req.body);
    const item = await requirementsService.copyWorkerFunctionRequirements(
      companyId,
      data.sourceId,
      data.targetId,
      data.mode,
    );
    res.json(item);
  },

  async copyContractorTypeRequirements(req: Request, res: Response) {
    const companyId = companyIdFrom(req);
    const data = copyRequirementsSchema.parse(req.body);
    const item = await requirementsService.copyContractorTypeRequirements(
      companyId,
      data.sourceId,
      data.targetId,
      data.mode,
    );
    res.json(item);
  },
};
