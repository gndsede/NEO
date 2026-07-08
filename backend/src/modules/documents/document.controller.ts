import type { Request, Response } from "express";
import { documentService } from "./document.service.js";
import {
  approveDocumentSchema,
  attachDocumentSchema,
  listDocumentsQuerySchema,
  rejectDocumentSchema,
} from "./document.schema.js";
import { Unauthorized } from "../../lib/errors.js";

function ctxFrom(req: Request) {
  if (!req.user) throw Unauthorized();
  return { companyId: req.user.companyId, reviewerId: req.user.id };
}

export const documentController = {
  /** GET /documents */
  async list(req: Request, res: Response) {
    if (!req.user) throw Unauthorized();
    const query = listDocumentsQuerySchema.parse(req.query);
    const result = await documentService.list(req.user, query);
    res.json(result);
  },

  /** GET /documents/:id */
  async getById(req: Request, res: Response) {
    if (!req.user) throw Unauthorized();
    const doc = await documentService.getById(req.user, String(req.params.id));
    res.json(doc);
  },

  /** PATCH /documents/:id/approve */
  async approve(req: Request, res: Response) {
    const ctx = ctxFrom(req);
    const { expiresAt } = approveDocumentSchema.parse(req.body ?? {});
    const doc = await documentService.approve(String(req.params.id), ctx, {
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
    res.json(doc);
  },

  /** PATCH /documents/:id/reject */
  async reject(req: Request, res: Response) {
    const ctx = ctxFrom(req);
    const { reason } = rejectDocumentSchema.parse(req.body);
    const doc = await documentService.reject(String(req.params.id), ctx, reason);
    res.json(doc);
  },

  /** POST /documents (multipart, campo `file`) */
  async attach(req: Request, res: Response) {
    if (!req.user) throw Unauthorized();
    const data = attachDocumentSchema.parse(req.body);
    const file = req.file as Express.Multer.File | undefined;
    const doc = await documentService.attach(
      req.user.companyId,
      data,
      file,
      req.user.id,
    );
    res.status(201).json(doc);
  },
};
