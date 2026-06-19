import type { Request, Response } from "express";
import { workerService } from "./worker.service.js";
import {
  addManualWorkerRequirementSchema,
  createWorkerSchema,
  importWorkersSchema,
  listAllRequirementsQuerySchema,
  listWorkersQuerySchema,
  setWorkerRequirementApplicabilitySchema,
  updateWorkerSchema,
} from "./worker.schema.js";
import { BadRequest, Unauthorized } from "../../lib/errors.js";
import { scopeFromRequest } from "../../lib/scope.js";
import { accessTokenPayload, withAccessToken } from "./worker.present.js";

type MulterFiles = Record<string, Express.Multer.File[]> | undefined;

export const workerController = {
  /** POST /workers — multipart/form-data (campos + photo + documents[]) */
  async create(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = createWorkerSchema.parse(req.body);

    const files = req.files as MulterFiles;
    const photo = files?.photo?.[0];
    const documents = files?.documents ?? [];

    const worker = await workerService.create({
      scope,
      data,
      photo,
      documents,
      createdById: req.user?.id,
    });

    res.status(201).json(withAccessToken(worker));
  },

  /** POST /workers/import — importação em lote (JSON com linhas da planilha). */
  async importBatch(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const { rows } = importWorkersSchema.parse(req.body);
    const result = await workerService.importBatch(scope, rows, req.user?.id);
    res.status(201).json(result);
  },

  /** GET /workers */
  async list(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const query = listWorkersQuerySchema.parse(req.query);
    const result = await workerService.list(scope, query);
    res.json({
      ...result,
      items: result.items.map(withAccessToken),
    });
  },

  /** GET /workers/:id/access-token — token para geração de QR por TI externa */
  async getAccessToken(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const worker = await workerService.findById(scope, String(req.params.id));
    res.json(accessTokenPayload(worker.qrHash));
  },

  /** PATCH /workers/:id/photo — atualiza a foto (multipart, campo `photo`) */
  async updatePhoto(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const photo = req.file as Express.Multer.File | undefined;
    if (!photo) throw BadRequest("Selecione uma foto (campo `photo`).");
    const worker = await workerService.updatePhoto(
      scope,
      String(req.params.id),
      photo,
    );
    res.json(withAccessToken(worker));
  },

  /** GET /workers/:id */
  async getById(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const worker = await workerService.findById(scope, String(req.params.id));
    res.json(withAccessToken(worker));
  },

  /** PATCH /workers/:id */
  async update(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = updateWorkerSchema.parse(req.body);
    const worker = await workerService.update(scope, String(req.params.id), data);
    res.json(withAccessToken(worker));
  },

  /** GET /workers/requirements — lista todas as exigências (aba Pendentes) */
  async listAllRequirements(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const query = listAllRequirementsQuerySchema.parse(req.query);
    const result = await workerService.listAllRequirements(scope, query);
    res.json(result);
  },

  /** GET /workers/requirements-summary — contadores do funil por situação */
  async requirementsSummary(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const summary = await workerService.requirementsSummary(scope);
    res.json(summary);
  },

  /** GET /workers/:id/requirements */
  async listRequirements(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const items = await workerService.listRequirements(
      scope,
      String(req.params.id),
    );
    res.json({ items });
  },

  /** POST /workers/:id/requirements/manual */
  async addManualRequirement(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = addManualWorkerRequirementSchema.parse(req.body);
    const item = await workerService.addManualRequirement(
      scope,
      String(req.params.id),
      data,
      req.user?.id,
    );
    res.status(201).json(item);
  },

  /** PATCH /workers/:id/requirements/:itemId/applicability */
  async setRequirementApplicability(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = setWorkerRequirementApplicabilitySchema.parse(req.body);
    const item = await workerService.setRequirementApplicability(
      scope,
      String(req.params.id),
      String(req.params.itemId),
      data,
    );
    res.json(item);
  },
};
