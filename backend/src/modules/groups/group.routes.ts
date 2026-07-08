import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { NotFound, Unauthorized } from "../../lib/errors.js";

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const upsertSchema = z.object({
  name: z.string().trim().min(2, "Nome do grupo é obrigatório"),
  description: z.string().trim().optional(),
  active: z.coerce.boolean().optional(),
  memberIds: z.array(z.string().min(1)).optional(),
});

async function withMembers(group: { id: string }) {
  const members = await prisma.userGroupMember.findMany({
    where: { groupId: group.id },
    include: { user: { select: { id: true, name: true, email: true, active: true } } },
  });
  return { ...group, members: members.map((m) => m.user) };
}

async function syncMembers(groupId: string, companyIdValue: string, memberIds: string[]) {
  const valid = await prisma.user.findMany({
    where: { id: { in: memberIds }, companyId: companyIdValue },
    select: { id: true },
  });
  if (valid.length !== memberIds.length) {
    throw NotFound("Um ou mais usuários informados não existem.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.userGroupMember.deleteMany({ where: { groupId } });
    if (memberIds.length > 0) {
      await tx.userGroupMember.createMany({
        data: memberIds.map((userId) => ({ groupId, userId })),
      });
    }
  });
}

router.get(
  "/",
  requireCapability("usuarios.view", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const groups = await prisma.userGroup.findMany({
      where: { companyId: companyId(req) },
      orderBy: { name: "asc" },
    });
    const items = await Promise.all(groups.map(withMembers));
    res.json({ items });
  }),
);

router.get(
  "/:id",
  requireCapability("usuarios.view", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const group = await prisma.userGroup.findFirst({
      where: { id: String(req.params.id), companyId: companyId(req) },
    });
    if (!group) throw NotFound("Grupo não encontrado");
    res.json(await withMembers(group));
  }),
);

router.post(
  "/",
  requireCapability("usuarios.manage"),
  asyncHandler(async (req, res) => {
    const data = upsertSchema.parse(req.body);
    const companyIdValue = companyId(req);

    const created = await prisma.userGroup.create({
      data: {
        companyId: companyIdValue,
        name: data.name,
        description: data.description,
        active: data.active ?? true,
      },
    });

    if (data.memberIds?.length) {
      await syncMembers(created.id, companyIdValue, data.memberIds);
    }

    res.status(201).json(await withMembers(created));
  }),
);

router.patch(
  "/:id",
  requireCapability("usuarios.manage"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const companyIdValue = companyId(req);
    const data = upsertSchema.partial().parse(req.body);

    const existing = await prisma.userGroup.findFirst({
      where: { id, companyId: companyIdValue },
      select: { id: true },
    });
    if (!existing) throw NotFound("Grupo não encontrado");

    const updated = await prisma.userGroup.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    if (data.memberIds !== undefined) {
      await syncMembers(id, companyIdValue, data.memberIds);
    }

    res.json(await withMembers(updated));
  }),
);

export const groupRoutes = router;
