import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { BadRequest, NotFound, Unauthorized } from "../../lib/errors.js";
import { hasCapability, normalizePermissions } from "../../lib/permissions.js";
import { obraWhere, scopeFromRequest } from "../../lib/scope.js";
import { obraUpsertSchema } from "./obras.schema.js";

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const items = await prisma.obra.findMany({
      where: {
        companyId: scope.companyId,
        active: true,
        ...obraWhere(scope),
      },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { contractors: true, workers: true, userAccess: true },
        },
      },
    });
    res.json({ items, activeObraId: scope.activeObraId });
  }),
);

router.get(
  "/all",
  requireCapability("obras.manage", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const items = await prisma.obra.findMany({
      where: { companyId: companyId(req) },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { contractors: true, workers: true, userAccess: true },
        },
      },
    });
    res.json({ items });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const item = await prisma.obra.findFirst({
      where: {
        id: String(req.params.id),
        companyId: scope.companyId,
        ...obraWhere(scope),
      },
      include: {
        _count: {
          select: { contractors: true, workers: true, userAccess: true },
        },
      },
    });
    if (!item) throw NotFound("Obra não encontrada");
    res.json(item);
  }),
);

router.post(
  "/",
  requireCapability("obras.manage"),
  asyncHandler(async (req, res) => {
    const data = obraUpsertSchema.parse(req.body);
    const companyIdValue = companyId(req);

    if (data.code) {
      const exists = await prisma.obra.findFirst({
        where: { companyId: companyIdValue, code: data.code },
        select: { id: true },
      });
      if (exists) throw BadRequest("Já existe uma obra com este código.");
    }

    const item = await prisma.obra.create({
      data: {
        companyId: companyIdValue,
        name: data.name,
        code: data.code,
        description: data.description,
        addressLine: data.addressLine,
        city: data.city,
        state: data.state,
        active: data.active ?? true,
        dataInicio: data.dataInicio ? new Date(data.dataInicio) : null,
        dataTerminoPrevisto: data.dataTerminoPrevisto ? new Date(data.dataTerminoPrevisto) : null,
      },
    });

    if (req.user) {
      await prisma.userObraAccess.create({
        data: { userId: req.user.id, obraId: item.id },
      }).catch(() => undefined);
    }

    res.status(201).json(item);
  }),
);

router.patch(
  "/:id",
  requireCapability("obras.manage"),
  asyncHandler(async (req, res) => {
    const data = obraUpsertSchema.partial().parse(req.body);
    const id = String(req.params.id);
    const companyIdValue = companyId(req);

    const existing = await prisma.obra.findFirst({
      where: { id, companyId: companyIdValue },
      select: { id: true },
    });
    if (!existing) throw NotFound("Obra não encontrada");

    if (data.code) {
      const duplicate = await prisma.obra.findFirst({
        where: { companyId: companyIdValue, code: data.code, NOT: { id } },
        select: { id: true },
      });
      if (duplicate) throw BadRequest("Já existe uma obra com este código.");
    }

    const { dataInicio, dataTerminoPrevisto, ...rest } = data;
    const item = await prisma.obra.update({
      where: { id },
      data: {
        ...rest,
        ...(dataInicio !== undefined ? { dataInicio: dataInicio ? new Date(dataInicio) : null } : {}),
        ...(dataTerminoPrevisto !== undefined ? { dataTerminoPrevisto: dataTerminoPrevisto ? new Date(dataTerminoPrevisto) : null } : {}),
      },
    });
    res.json(item);
  }),
);

router.get(
  "/:id/users",
  requireCapability("obras.manage", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const companyIdValue = companyId(req);
    const obraId = String(req.params.id);
    const obra = await prisma.obra.findFirst({
      where: { id: obraId, companyId: companyIdValue },
      select: { id: true },
    });
    if (!obra) throw NotFound("Obra não encontrada");

    const access = await prisma.userObraAccess.findMany({
      where: { obraId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            profile: true,
            active: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ items: access.map((a) => a.user) });
  }),
);

router.put(
  "/users/:userId/access",
  requireCapability("usuarios.manage"),
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId);
    const { obraIds } = z
      .object({ obraIds: z.array(z.string().min(1)).min(1) })
      .parse(req.body);
    const companyIdValue = companyId(req);

    const user = await prisma.user.findFirst({
      where: { id: userId, companyId: companyIdValue },
      select: { id: true, permissions: true },
    });
    if (!user) throw NotFound("Usuário não encontrado");
    if (
      hasCapability(
        { permissions: normalizePermissions(user.permissions) },
        "obras.manage",
      )
    ) {
      throw BadRequest("Usuários com gestão de obras já possuem acesso a todas as obras.");
    }

    const validObras = await prisma.obra.findMany({
      where: { companyId: companyIdValue, id: { in: obraIds }, active: true },
      select: { id: true },
    });
    if (validObras.length !== obraIds.length) {
      throw BadRequest("Uma ou mais obras são inválidas.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.userObraAccess.deleteMany({ where: { userId } });
      await tx.userObraAccess.createMany({
        data: obraIds.map((obraId) => ({ userId, obraId })),
      });
    });

    res.json({ ok: true, obraIds });
  }),
);

export const obrasRoutes = router;
