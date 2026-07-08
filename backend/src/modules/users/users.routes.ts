import { Router, type Request } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma, UserProfile } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { BadRequest, NotFound, Unauthorized } from "../../lib/errors.js";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  normalizePermissions,
  type PermissionKey,
} from "../../lib/permissions.js";
import { hasCapability } from "../../lib/permissions.js";

const router = Router();
router.use(authenticate);

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const permissionsSchema = z.array(z.string()).optional();

const createSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  password: z.string().min(8, "Senha deve ter ao menos 8 caracteres"),
  profile: z.nativeEnum(UserProfile).default(UserProfile.USER),
  contractorId: z.string().optional(),
  obraIds: z.array(z.string().min(1)).optional(),
  permissions: permissionsSchema,
  active: z.coerce.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).optional(),
  password: z.string().min(8, "Senha deve ter ao menos 8 caracteres").optional(),
  profile: z.nativeEnum(UserProfile).optional(),
  contractorId: z.string().nullable().optional(),
  obraIds: z.array(z.string().min(1)).optional(),
  permissions: permissionsSchema,
  active: z.coerce.boolean().optional(),
});

function sanitizePermissions(input: string[] | undefined): PermissionKey[] {
  if (!input) return [];
  return input.filter((k): k is PermissionKey =>
    ALL_PERMISSION_KEYS.includes(k as PermissionKey),
  );
}

async function publicUser(u: {
  id: string;
  name: string;
  email: string;
  profile: UserProfile;
  contractorId: string | null;
  permissions: unknown;
  active: boolean;
  createdAt: Date;
}) {
  const obraAccess = await prisma.userObraAccess.findMany({
    where: { userId: u.id },
    include: { obra: { select: { id: true, name: true, code: true } } },
  });
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    profile: u.profile,
    contractorId: u.contractorId,
    obraIds: obraAccess.map((a) => a.obraId),
    obras: obraAccess.map((a) => a.obra),
    active: u.active,
    permissions: normalizePermissions(u.permissions),
    createdAt: u.createdAt,
  };
}

async function syncUserObraAccess(
  userId: string,
  companyId: string,
  obraIds: string[] | undefined,
  permissions: PermissionKey[],
) {
  if (hasCapability({ permissions }, "obras.manage") || !obraIds) return;
  const valid = await prisma.obra.findMany({
    where: { companyId, id: { in: obraIds }, active: true },
    select: { id: true },
  });
  if (valid.length !== obraIds.length) {
    throw BadRequest("Uma ou mais obras são inválidas.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.userObraAccess.deleteMany({ where: { userId } });
    await tx.userObraAccess.createMany({
      data: obraIds.map((obraId) => ({ userId, obraId })),
    });
  });
}

router.get("/permissions-catalog", (_req, res) => {
  res.json({ items: PERMISSION_CATALOG });
});

router.get(
  "/",
  requireCapability("usuarios.view", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      where: { companyId: companyId(req) },
      orderBy: { createdAt: "asc" },
    });
    res.json({ items: await Promise.all(users.map(publicUser)) });
  }),
);

router.get(
  "/:id",
  requireCapability("usuarios.view", "usuarios.manage"),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: String(req.params.id), companyId: companyId(req) },
    });
    if (!user) throw NotFound("Usuário não encontrado");
    res.json(await publicUser(user));
  }),
);

router.post(
  "/",
  requireCapability("usuarios.manage"),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const email = data.email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw BadRequest("Já existe um usuário com este e-mail.");

    if (data.contractorId) {
      const contractor = await prisma.contractor.findFirst({
        where: { id: data.contractorId, companyId: companyId(req) },
        select: { id: true },
      });
      if (!contractor) throw BadRequest("Fornecedor não encontrado.");
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    if (data.profile === "COLLABORATOR" && !data.contractorId) {
      throw BadRequest("Colaborador deve estar vinculado a uma empreiteira.");
    }

    const permissions = sanitizePermissions(data.permissions);

    const created = await prisma.user.create({
      data: {
        companyId: companyId(req),
        name: data.name,
        email,
        passwordHash,
        profile: data.profile,
        contractorId: data.contractorId ?? null,
        active: data.active ?? true,
        permissions: permissions as unknown as Prisma.InputJsonValue,
      },
    });

    const obraIds =
      data.obraIds ??
      (
        await prisma.obra.findMany({
          where: { companyId: companyId(req), active: true },
          select: { id: true },
          take: 1,
        })
      ).map((o) => o.id);

    await syncUserObraAccess(
      created.id,
      companyId(req),
      obraIds,
      permissions,
    );

    res.status(201).json(await publicUser(created));
  }),
);

router.patch(
  "/:id",
  requireCapability("usuarios.manage"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const data = updateSchema.parse(req.body);

    const existing = await prisma.user.findFirst({
      where: { id, companyId: companyId(req) },
    });
    if (!existing) throw NotFound("Usuário não encontrado");

    if (data.contractorId) {
      const contractor = await prisma.contractor.findFirst({
        where: { id: data.contractorId, companyId: companyId(req) },
        select: { id: true },
      });
      if (!contractor) throw BadRequest("Fornecedor não encontrado.");
    }

    const nextProfile = data.profile ?? existing.profile;
    const nextContractorId =
      "contractorId" in data ? data.contractorId ?? null : existing.contractorId;
    if (nextProfile === "COLLABORATOR" && !nextContractorId) {
      throw BadRequest("Colaborador deve estar vinculado a uma empreiteira.");
    }

    const nextPermissions =
      data.permissions !== undefined
        ? sanitizePermissions(data.permissions)
        : normalizePermissions(existing.permissions);

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.profile !== undefined ? { profile: data.profile } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...("contractorId" in data ? { contractorId: data.contractorId ?? null } : {}),
        ...(data.permissions !== undefined
          ? {
              permissions: nextPermissions as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(data.password
          ? { passwordHash: await bcrypt.hash(data.password, 10) }
          : {}),
      },
    });

    if (data.obraIds) {
      await syncUserObraAccess(
        updated.id,
        companyId(req),
        data.obraIds,
        nextPermissions,
      );
    }

    res.json(await publicUser(updated));
  }),
);

export const usersRoutes = router;
