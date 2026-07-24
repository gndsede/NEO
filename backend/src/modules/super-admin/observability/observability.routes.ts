import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import { asyncHandler } from "../../../middleware/async-handler.js";
import { BadRequest, NotFound } from "../../../lib/errors.js";
import { ALERT_METRICS } from "../../../lib/alert-engine.js";
import {
  getCacheMetrics,
  getDbMetrics,
  getDetailedHealth,
  getPerformanceMetrics,
  listErrors,
} from "./observability.service.js";

const router = Router();

// GET /super-admin/observability/health
router.get(
  "/health",
  asyncHandler(async (_req, res) => {
    res.json(await getDetailedHealth());
  }),
);

// GET /super-admin/observability/metrics
router.get(
  "/metrics",
  asyncHandler(async (_req, res) => {
    res.json(await getPerformanceMetrics());
  }),
);

// GET /super-admin/observability/db
router.get(
  "/db",
  asyncHandler(async (_req, res) => {
    res.json(getDbMetrics());
  }),
);

// GET /super-admin/observability/cache
router.get(
  "/cache",
  asyncHandler(async (_req, res) => {
    res.json(getCacheMetrics());
  }),
);

// GET /super-admin/observability/errors?take=50&statusCode=500
router.get(
  "/errors",
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.take) || 50, 200);
    const statusCode = req.query.statusCode ? Number(req.query.statusCode) : undefined;
    const items = await listErrors({ take, statusCode });
    res.json({ items });
  }),
);

// ---------------------------------------------------------------------------
// Regras de alerta
// ---------------------------------------------------------------------------

const alertRuleSchema = z.object({
  metric: z.enum(ALERT_METRICS),
  threshold: z.number().positive(),
  windowMinutes: z.number().int().positive().default(5),
  enabled: z.boolean().default(true),
  recipientEmail: z.string().email(),
  cooldownMinutes: z.number().int().positive().default(30),
});

// GET /super-admin/observability/alerts
router.get(
  "/alerts",
  asyncHandler(async (_req, res) => {
    const items = await prisma.alertRule.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ items });
  }),
);

// POST /super-admin/observability/alerts
router.post(
  "/alerts",
  asyncHandler(async (req, res) => {
    const data = alertRuleSchema.parse(req.body);
    const rule = await prisma.alertRule.create({ data });
    res.status(201).json(rule);
  }),
);

// PATCH /super-admin/observability/alerts/:id
router.patch(
  "/alerts/:id",
  asyncHandler(async (req, res) => {
    const data = alertRuleSchema.partial().parse(req.body);
    if (Object.keys(data).length === 0) throw BadRequest("Nenhum campo para atualizar");
    const id = String(req.params.id);

    const existing = await prisma.alertRule.findUnique({ where: { id } });
    if (!existing) throw NotFound("Regra de alerta não encontrada");

    const rule = await prisma.alertRule.update({ where: { id }, data });
    res.json(rule);
  }),
);

// DELETE /super-admin/observability/alerts/:id
router.delete(
  "/alerts/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await prisma.alertRule.findUnique({ where: { id } });
    if (!existing) throw NotFound("Regra de alerta não encontrada");

    await prisma.alertRule.delete({ where: { id } });
    res.status(204).send();
  }),
);

// GET /super-admin/observability/alerts/events
router.get(
  "/alerts/events",
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.take) || 50, 200);
    const items = await prisma.alertEvent.findMany({
      orderBy: { createdAt: "desc" },
      take,
      include: { rule: { select: { metric: true, recipientEmail: true } } },
    });
    res.json({ items });
  }),
);

export { router as observabilityRoutes };
