import type { Request, Response } from "express";
import { workerService } from "./worker.service.js";
import {
  addManualWorkerRequirementSchema,
  createAssignmentSchema,
  createWorkerSchema,
  importWorkersSchema,
  listAllRequirementsQuerySchema,
  listWorkersQuerySchema,
  setWorkerRequirementApplicabilitySchema,
  updateAssignmentSchema,
  updateWorkerSchema,
} from "./worker.schema.js";
import { BadRequest } from "../../lib/errors.js";
import { scopeFromRequest } from "../../lib/scope.js";
import { accessTokenPayload, presentWorker } from "./worker.present.js";

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

    res.status(201).json(presentWorker(worker, scope));
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
      items: result.items.map((worker) => presentWorker(worker, scope)),
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
    res.json(presentWorker(worker, scope));
  },

  /** GET /workers/:id */
  async getById(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const worker = await workerService.findById(scope, String(req.params.id));
    res.json(presentWorker(worker, scope));
  },

  /** PATCH /workers/:id */
  async update(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const workerId = String(req.params.id);
    const personal = updateWorkerSchema.parse(req.body);
    const assignment = updateAssignmentSchema.parse(req.body);

    await workerService.update(scope, workerId, personal);

    const assignmentId = await workerService.resolvePrimaryAssignmentId(
      scope,
      workerId,
    );
    const hasAssignmentUpdates = Object.values(assignment).some(
      (v) => v !== undefined,
    );
    if (assignmentId && hasAssignmentUpdates) {
      await workerService.updateAssignment(
        scope,
        workerId,
        assignmentId,
        assignment,
      );
    }

    const worker = await workerService.findById(scope, workerId);
    res.json(presentWorker(worker, scope));
  },

  /** POST /workers/:id/assignments — vincula colaborador a outra obra */
  async addAssignment(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = createAssignmentSchema.parse(req.body);
    const assignment = await workerService.addAssignment(
      scope,
      String(req.params.id),
      data,
      req.user?.id,
    );
    res.status(201).json(assignment);
  },

  /** PATCH /workers/:id/assignments/:assignmentId — atualiza dados do vínculo */
  async updateAssignment(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = updateAssignmentSchema.parse(req.body);
    const assignment = await workerService.updateAssignment(
      scope,
      String(req.params.id),
      String(req.params.assignmentId),
      data,
    );
    res.json(assignment);
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

  /** GET /workers/:id/requirements?assignmentId=... */
  async listRequirements(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const assignmentId = req.query.assignmentId ? String(req.query.assignmentId) : undefined;
    const items = await workerService.listRequirements(
      scope,
      String(req.params.id),
      assignmentId,
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

  /**
   * POST /workers/:id/anonymize
   * Direito ao apagamento (LGPD Art. 18): anonimiza dados PII do colaborador.
   * Requer permissão colaboradores.manage e confirmação explícita no body.
   */
  async anonymize(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    if (req.body?.confirm !== true) {
      throw BadRequest(
        'Envie { "confirm": true } no body para confirmar a anonimização irreversível.',
      );
    }
    const result = await workerService.anonymize(
      scope,
      String(req.params.id),
      req.user!.id,
    );
    res.json(result);
  },
};
