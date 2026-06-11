import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, signUserToken } from "../../middleware/auth.js";
import { Forbidden, Unauthorized } from "../../lib/errors.js";
import { hasCapability, normalizePermissions } from "../../lib/permissions.js";
import { loadObraIdsForUser } from "../../lib/scope.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      include: {
        obraAccess: { include: { obra: { select: { id: true, name: true, code: true } } } },
        contractor: { select: { id: true, name: true } },
      },
    });
    if (!user || !user.active) throw Unauthorized("Credenciais inválidas");

    let ok = false;
    let authUser = user;

    if (isBcryptHash(user.passwordHash)) {
      ok = await bcrypt.compare(password, user.passwordHash);
    } else {
      ok = password === user.passwordHash;
      if (ok) {
        const upgradedHash = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: upgradedHash, email: normalizedEmail },
        });
        authUser = {
          ...user,
          passwordHash: upgradedHash,
          email: normalizedEmail,
        };
      }
    }

    if (!ok) throw Unauthorized("Credenciais inválidas");

    const permissions = normalizePermissions(authUser.permissions);

    const obraIds = await loadObraIdsForUser({
      userId: authUser.id,
      companyId: authUser.companyId,
      permissions,
    });

    const obras = await prisma.obra.findMany({
      where: {
        companyId: authUser.companyId,
        active: true,
        id: { in: obraIds },
      },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });

    const token = signUserToken({
      id: authUser.id,
      companyId: authUser.companyId,
      profile: authUser.profile,
      email: authUser.email,
      contractorId: authUser.contractorId,
      permissions,
      obraIds,
      activeObraId: obras[0]?.id ?? null,
    });

    res.json({
      token,
      user: {
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        profile: authUser.profile,
        companyId: authUser.companyId,
        contractorId: authUser.contractorId,
        contractor: authUser.contractor,
        permissions,
        obraIds,
        obras,
      },
    });
  }),
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const obras = await prisma.obra.findMany({
      where: {
        companyId: scope.companyId,
        active: true,
        id: { in: scope.obraIds },
      },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });
    res.json({
      user: {
        ...scope,
        obras,
      },
    });
  }),
);

const mobileLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().min(1).max(120).optional(),
  deviceName: z.string().min(1).max(120).optional(),
});

/**
 * Login dedicado ao app da portaria.
 * Exige a capacidade `catraca.manage` (porteiro/operador) e retorna,
 * além do JWT, a lista de obras autorizadas e metadados úteis para sync.
 */
router.post(
  "/mobile-login",
  asyncHandler(async (req, res) => {
    const { email, password, deviceId, deviceName } = mobileLoginSchema.parse(
      req.body,
    );
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      include: {
        company: { select: { id: true, name: true, siteName: true } },
      },
    });
    if (!user || !user.active) throw Unauthorized("Credenciais inválidas");

    let ok = false;
    let authUser = user;
    if (isBcryptHash(user.passwordHash)) {
      ok = await bcrypt.compare(password, user.passwordHash);
    } else {
      ok = password === user.passwordHash;
      if (ok) {
        const upgradedHash = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: upgradedHash, email: normalizedEmail },
        });
        authUser = {
          ...user,
          passwordHash: upgradedHash,
          email: normalizedEmail,
        };
      }
    }
    if (!ok) throw Unauthorized("Credenciais inválidas");

    const permissions = normalizePermissions(authUser.permissions);

    if (!hasCapability({ permissions }, "catraca.manage")) {
      throw Forbidden(
        "Este usuário não tem permissão para operar a catraca no aplicativo.",
      );
    }

    const obraIds = await loadObraIdsForUser({
      userId: authUser.id,
      companyId: authUser.companyId,
      permissions,
    });

    const obras = await prisma.obra.findMany({
      where: {
        companyId: authUser.companyId,
        active: true,
        id: { in: obraIds },
      },
      select: { id: true, name: true, code: true, city: true, state: true },
      orderBy: { name: "asc" },
    });

    const token = signUserToken({
      id: authUser.id,
      companyId: authUser.companyId,
      profile: authUser.profile,
      email: authUser.email,
      contractorId: authUser.contractorId,
      permissions,
      obraIds,
      activeObraId: obras[0]?.id ?? null,
    });

    res.json({
      token,
      serverTime: new Date().toISOString(),
      device: deviceId ? { id: deviceId, name: deviceName ?? null } : null,
      user: {
        id: authUser.id,
        name: authUser.name,
        email: authUser.email,
        profile: authUser.profile,
        companyId: authUser.companyId,
        company: authUser.company,
        permissions,
        obras,
      },
    });
  }),
);

export const authRoutes = router;
