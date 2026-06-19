import type { Request, Response } from "express";
import { rdoService } from "./rdo.service.js";
import {
  createRdoSchema,
  listRdoSchema,
  rejectRdoSchema,
  updateRdoSchema,
} from "./rdo.schema.js";
import { scopeFromRequest } from "../../lib/scope.js";
import { generateRdoPdf } from "./rdo.pdf.js";
import { prisma } from "../../lib/prisma.js";
import { z } from "zod";

export const rdoController = {
  async list(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const query = listRdoSchema.parse(req.query);
    res.json(await rdoService.list(scope, query));
  },

  async getById(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    res.json(await rdoService.getById(scope, String(req.params.id)));
  },

  async create(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = createRdoSchema.parse(req.body);
    res.status(201).json(await rdoService.create(scope, data, scope.id));
  },

  async update(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const data = updateRdoSchema.parse(req.body);
    res.json(await rdoService.update(scope, String(req.params.id), data));
  },

  async submitForApproval(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    res.json(await rdoService.submitForApproval(scope, String(req.params.id)));
  },

  async approve(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    res.json(await rdoService.approve(scope, String(req.params.id)));
  },

  async reject(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const input = rejectRdoSchema.parse(req.body);
    res.json(await rdoService.reject(scope, String(req.params.id), input));
  },

  async remove(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    await rdoService.remove(scope, String(req.params.id));
    res.status(204).end();
  },

  async exportPdf(req: Request, res: Response) {
    const scope = scopeFromRequest(req);
    const { from, to, ids } = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        ids: z.string().optional(),
      })
      .parse(req.query);

    const where: Record<string, unknown> = { companyId: scope.companyId };

    if (ids) {
      where["id"] = { in: ids.split(",").map((s) => s.trim()).filter(Boolean) };
    } else {
      if (from) where["data"] = { ...(where["data"] as object | undefined), gte: new Date(from) };
      if (to) where["data"] = { ...(where["data"] as object | undefined), lte: new Date(to) };
    }

    const rdos = await prisma.rdo.findMany({
      where,
      orderBy: { data: "asc" },
      include: {
        obra: { select: { name: true } },
        createdBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
      },
    });

    if (rdos.length === 0) {
      res.status(404).json({ error: "Nenhum RDO encontrado para o período." });
      return;
    }

    const pdf = await generateRdoPdf(rdos);
    const filename = `rdos-${from ?? "todos"}-${to ?? ""}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  },
};
