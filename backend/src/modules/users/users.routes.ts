import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
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
import { hashPassword } from "../../lib/password.js";
import { sendUserInviteEmail } from "../../lib/invite-email.js";
import { env } from "../../config/env.js";
import { auditContext, recordAudit } from "../../lib/audit.js";

const router = Router();
router.use(authenticate);

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const permissionsSchema = z.array(z.string()).optional();

const createSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().email(),
  // Sem senha: o usuário recebe um convite por e-mail para defini-la (fluxo
  // padrão). Uma senha só é aceita aqui para os poucos casos em que o admin
  // precisa definir o acesso na hora (ex.: sem e-mail configurado no tenant).
  password: z.string().min(8, "Senha deve ter ao menos 8 caracteres").optional(),
  profile: z.nativeEnum(UserProfile).default(UserProfile.USER),
  contractorId: z.string().optional(),
  obraIds: z.array(z.string().min(1)).optional(),
  /// Se true, o usuário enxerga todas as obras automaticamente (inclusive
  /// futuras), independente da permissão obras.manage.
  allObrasAccess: z.coerce.boolean().optional(),
  permissions: permissionsSchema,
  active: z.coerce.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).optional(),
  password: z.string().min(8, "Senha deve ter ao menos 8 caracteres").optional(),
  profile: z.nativeEnum(UserProfile).optional(),
  contractorId: z.string().nullable().optional(),
  obraIds: z.array(z.string().min(1)).optional(),
  allObrasAccess: z.coerce.boolean().optional(),
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
  allObrasAccess: boolean;
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
    allObrasAccess: u.allObrasAccess,
    active: u.active,
    permissions: normalizePermissions(u.permissions),
    createdAt: u.createdAt,
  };
}

async function syncUserObraAccess(
  userId: string,
  companyId: string,
  obraIds: string[] | undefined,
  allObrasAccess: boolean,
) {
  if (allObrasAccess || !obraIds) return;
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

    // Mensagem genérica: e-mail é único na plataforma inteira (cross-tenant);
    // confirmar "já existe" permitiria enumerar contas de outros tenants
    // (auditoria F16 — CWE-203).
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw BadRequest(
        "Não foi possível concluir o cadastro com este e-mail. Verifique os dados ou use outro endereço.",
      );
    }

    if (data.contractorId) {
      const contractor = await prisma.contractor.findFirst({
        where: { id: data.contractorId, companyId: companyId(req) },
        select: { id: true },
      });
      if (!contractor) throw BadRequest("Fornecedor não encontrado.");
    }

    if (data.profile === "COLLABORATOR" && !data.contractorId) {
      throw BadRequest("Colaborador deve estar vinculado a uma empreiteira.");
    }

    // Sem senha informada: fluxo padrão de convite por e-mail (o usuário
    // define a própria senha). Com senha: admin define o acesso na hora.
    const sendInvite = !data.password;
    const inviteToken = sendInvite ? randomBytes(32).toString("hex") : null;
    const inviteTokenExpiresAt = sendInvite
      ? new Date(Date.now() + INVITE_TOKEN_TTL_MS)
      : null;
    const passwordHash = await hashPassword(
      data.password ?? randomBytes(32).toString("hex"),
    );

    const permissions = sanitizePermissions(data.permissions);
    const allObrasAccess = data.allObrasAccess ?? false;

    const created = await prisma.user.create({
      data: {
        companyId: companyId(req),
        name: data.name,
        email,
        passwordHash,
        profile: data.profile,
        contractorId: data.contractorId ?? null,
        active: sendInvite ? false : (data.active ?? true),
        allObrasAccess,
        permissions: permissions as unknown as Prisma.InputJsonValue,
        inviteToken,
        inviteTokenExpiresAt,
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
      allObrasAccess,
    );

    let inviteSent: boolean | undefined;
    let inviteUrl: string | undefined;
    if (sendInvite && inviteToken) {
      const company = await prisma.company.findUnique({
        where: { id: companyId(req) },
        select: { name: true },
      });
      inviteSent = await sendUserInviteEmail({
        recipientEmail: email,
        recipientName: data.name,
        companyName: company?.name ?? "",
        inviteToken,
      });
      // Sempre devolvemos o link — o e-mail é só uma conveniência; se falhar
      // (Resend não configurado, domínio não verificado etc.), o admin ainda
      // consegue copiar e enviar manualmente.
      inviteUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/aceitar-convite?token=${encodeURIComponent(inviteToken)}`;
    }

    await recordAudit({
      ...auditContext(req),
      action: "USER_CREATED",
      entityType: "user",
      entityId: created.id,
      meta: { email, profile: data.profile, permissions, invited: sendInvite },
    });

    res.status(201).json({
      ...(await publicUser(created)),
      ...(sendInvite ? { inviteSent, inviteUrl } : {}),
    });
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
    const nextAllObrasAccess =
      data.allObrasAccess !== undefined ? data.allObrasAccess : existing.allObrasAccess;

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.profile !== undefined ? { profile: data.profile } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...("contractorId" in data ? { contractorId: data.contractorId ?? null } : {}),
        ...(data.allObrasAccess !== undefined ? { allObrasAccess: data.allObrasAccess } : {}),
        ...(data.permissions !== undefined
          ? {
              permissions: nextPermissions as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(data.password
          ? { passwordHash: await hashPassword(data.password) }
          : {}),
      },
    });

    if (data.obraIds) {
      await syncUserObraAccess(
        updated.id,
        companyId(req),
        data.obraIds,
        nextAllObrasAccess,
      );
    }

    const permissionsChanged =
      data.permissions !== undefined &&
      JSON.stringify(normalizePermissions(existing.permissions).sort()) !==
        JSON.stringify([...nextPermissions].sort());

    await recordAudit({
      ...auditContext(req),
      action: permissionsChanged ? "USER_PERMISSIONS_CHANGED" : "USER_UPDATED",
      entityType: "user",
      entityId: updated.id,
      meta: {
        changedFields: Object.keys(data),
        ...(permissionsChanged
          ? {
              permissionsBefore: normalizePermissions(existing.permissions),
              permissionsAfter: nextPermissions,
            }
          : {}),
      },
    });

    res.json(await publicUser(updated));
  }),
);

export const usersRoutes = router;
