import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, signUserToken } from "../../middleware/auth.js";
import { loginRateLimit } from "../../middleware/rate-limit.js";
import { BadRequest, Forbidden, Unauthorized } from "../../lib/errors.js";
import { hasAnyCapability, hasCapability, normalizePermissions } from "../../lib/permissions.js";
import { loadObraIdsForUser } from "../../lib/scope.js";
import { env } from "../../config/env.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gera um token de pré-autenticação (pré-2FA).
 * Contém apenas userId e companyId — sem permissões.
 * Válido por 5 minutos (janela para o usuário digitar o código TOTP).
 */
function signPreAuthToken(userId: string, companyId: string): string {
  return jwt.sign({ sub: userId, companyId, aud: "pre-auth" }, env.JWT_SECRET, {
    expiresIn: "5m",
  });
}

interface PreAuthClaims {
  sub: string;
  companyId: string;
  aud: string;
}

function verifyPreAuthToken(token: string): PreAuthClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as PreAuthClaims;
    if (decoded.aud !== "pre-auth") throw new Error("audience inválido");
    return decoded;
  } catch {
    throw Unauthorized("Token de pré-autenticação inválido ou expirado");
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Código TOTP deve ter 6 dígitos"),
});

const login2faSchema = z.object({
  preAuthToken: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Código TOTP deve ter 6 dígitos"),
});

const mobileLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
  deviceId: z.string().min(1).max(120).optional(),
  deviceName: z.string().min(1).max(120).optional(),
});

/** Bloqueia login de tenants bloqueados pelo super-admin ou com licença vencida. */
function ensureCompanyActive(company: {
  blocked: boolean;
  licenseExpiresAt: Date | null;
}): void {
  if (company.blocked) {
    throw Forbidden("Empresa bloqueada. Entre em contato com o suporte NEO.");
  }
  if (company.licenseExpiresAt && company.licenseExpiresAt < new Date()) {
    throw Forbidden("Licença expirada. Entre em contato com o suporte NEO.");
  }
}

// ---------------------------------------------------------------------------
// Login padrão (web)
// ---------------------------------------------------------------------------

router.post(
  "/login",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      include: {
        obraAccess: { include: { obra: { select: { id: true, name: true, code: true } } } },
        contractor: { select: { id: true, name: true } },
        company: { select: { blocked: true, licenseExpiresAt: true } },
      },
    });
    if (!user || !user.active) throw Unauthorized("Credenciais inválidas");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw Unauthorized("Credenciais inválidas");

    ensureCompanyActive(user.company);

    const preAuthToken = signPreAuthToken(user.id, user.companyId);

    // 2FA já ativo: segunda etapa é apenas o código
    if (user.totpEnabled) {
      return res.json({ requires2FA: true, preAuthToken });
    }

    // 2FA ainda não configurado: o enrolamento acontece no próprio login.
    // Gera um segredo provisório e retorna o QR Code; a ativação ocorre em
    // POST /auth/login/2fa quando o primeiro código é validado.
    const secret = authenticator.generateSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: secret, totpEnabled: false },
    });

    const otpauthUri = authenticator.keyuri(user.email, "NEO AccessHub", secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
      width: 256,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    res.json({ requires2FASetup: true, preAuthToken, qrCodeDataUrl, secret });
  }),
);

// ---------------------------------------------------------------------------
// Validação do código TOTP após login (segunda etapa)
// ---------------------------------------------------------------------------

router.post(
  "/login/2fa",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { preAuthToken, code } = login2faSchema.parse(req.body);

    const claims = verifyPreAuthToken(preAuthToken);

    const user = await prisma.user.findFirst({
      where: { id: claims.sub, companyId: claims.companyId, active: true },
      include: {
        contractor: { select: { id: true, name: true } },
        company: { select: { blocked: true, licenseExpiresAt: true } },
      },
    });
    if (!user || !user.totpSecret) {
      throw Unauthorized("2FA não configurado para este usuário");
    }
    ensureCompanyActive(user.company);

    const valid = authenticator.check(code, user.totpSecret);
    if (!valid) throw Unauthorized("Código TOTP inválido ou expirado");

    // Primeiro código válido após o enrolamento no login: ativa o 2FA
    if (!user.totpEnabled) {
      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: true },
      });
    }

    const permissions = normalizePermissions(user.permissions);
    const obraIds = await loadObraIdsForUser({
      userId: user.id,
      companyId: user.companyId,
      permissions,
    });

    const obras = await prisma.obra.findMany({
      where: { companyId: user.companyId, active: true, id: { in: obraIds } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });

    const token = signUserToken({
      id: user.id,
      companyId: user.companyId,
      profile: user.profile,
      email: user.email,
      contractorId: user.contractorId,
      permissions,
      obraIds,
      activeObraId: obras[0]?.id ?? null,
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profile: user.profile,
        companyId: user.companyId,
        contractorId: user.contractorId,
        contractor: user.contractor,
        permissions,
        obraIds,
        obras,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Perfil do usuário autenticado
// ---------------------------------------------------------------------------

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const user = await prisma.user.findUnique({
      where: { id: scope.id },
      select: { totpEnabled: true },
    });
    const obras = await prisma.obra.findMany({
      where: { companyId: scope.companyId, active: true, id: { in: scope.obraIds } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });
    res.json({
      user: {
        ...scope,
        obras,
        totpEnabled: user?.totpEnabled ?? false,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Configuração do 2FA (requer autenticação completa)
// ---------------------------------------------------------------------------

/**
 * GET /auth/2fa/setup
 * Gera um novo segredo TOTP e retorna o QR Code (URI data:image/png;base64,...)
 * para escanear no Google Authenticator / Authy.
 * NÃO ativa o 2FA ainda — a ativação ocorre em POST /auth/2fa/enable.
 */
router.get(
  "/2fa/setup",
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const user = await prisma.user.findUnique({
      where: { id: scope.id },
      select: { email: true, totpEnabled: true },
    });
    if (!user) throw Unauthorized();
    if (user.totpEnabled) {
      throw BadRequest("2FA já está ativado. Desative-o antes de reconfigurar.");
    }

    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(user.email, "NEO AccessHub", secret);
    const qrDataUrl = await QRCode.toDataURL(uri, {
      width: 256,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    // Salva o segredo provisoriamente (ainda não habilitado)
    await prisma.user.update({
      where: { id: scope.id },
      data: { totpSecret: secret, totpEnabled: false },
    });

    res.json({
      secret,
      otpauthUri: uri,
      qrCodeDataUrl: qrDataUrl,
      instructions: [
        "1. Abra o Google Authenticator (ou Authy) no seu celular.",
        "2. Toque em '+' → 'Escanear código QR'.",
        "3. Escaneie o QR Code exibido acima.",
        "4. Envie o código de 6 dígitos gerado para POST /auth/2fa/enable para confirmar.",
      ],
    });
  }),
);

/**
 * POST /auth/2fa/enable
 * Ativa o 2FA após o usuário confirmar com o primeiro código do Authenticator.
 */
router.post(
  "/2fa/enable",
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const { code } = totpCodeSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: scope.id },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user) throw Unauthorized();
    if (user.totpEnabled) throw BadRequest("2FA já está ativado.");
    if (!user.totpSecret) {
      throw BadRequest("Configure o 2FA primeiro via GET /auth/2fa/setup.");
    }

    const valid = authenticator.check(code, user.totpSecret);
    if (!valid) {
      throw Unauthorized(
        "Código inválido. Verifique o horário do celular e tente novamente.",
      );
    }

    await prisma.user.update({
      where: { id: scope.id },
      data: { totpEnabled: true },
    });

    res.json({
      success: true,
      message: "Autenticação em dois fatores ativada com sucesso.",
    });
  }),
);

/**
 * DELETE /auth/2fa/disable
 * Desativa o 2FA após confirmar com o código atual do Authenticator.
 */
router.delete(
  "/2fa/disable",
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const { code } = totpCodeSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: scope.id },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user) throw Unauthorized();
    if (!user.totpEnabled || !user.totpSecret) {
      throw BadRequest("2FA não está ativado.");
    }

    const valid = authenticator.check(code, user.totpSecret);
    if (!valid) throw Unauthorized("Código TOTP inválido.");

    await prisma.user.update({
      where: { id: scope.id },
      data: { totpEnabled: false, totpSecret: null },
    });

    res.json({
      success: true,
      message: "Autenticação em dois fatores desativada.",
    });
  }),
);

// ---------------------------------------------------------------------------
// Login para o app da catraca (mobile)
// ---------------------------------------------------------------------------

const mobileLoginSchemaFull = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
  deviceId: z.string().min(1).max(120).optional(),
  deviceName: z.string().min(1).max(120).optional(),
});

router.post(
  "/mobile-login",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password, code, deviceId, deviceName } = mobileLoginSchemaFull.parse(req.body);
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      include: {
        company: {
          select: { id: true, name: true, siteName: true, blocked: true, licenseExpiresAt: true },
        },
      },
    });
    if (!user || !user.active) throw Unauthorized("Credenciais inválidas");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw Unauthorized("Credenciais inválidas");

    ensureCompanyActive(user.company);

    const permissions = normalizePermissions(user.permissions);

    if (!hasAnyCapability({ permissions }, ["catraca.manage", "catraca.view"])) {
      throw Forbidden(
        "Este usuário não tem permissão para operar a catraca. Peça ao administrador as permissões «Visualizar catraca» ou «Registrar acessos manualmente».",
      );
    }

    // 2FA ainda não configurado: enrolamento no próprio app (como no painel web).
    if (!user.totpEnabled || !user.totpSecret) {
      let secret = user.totpSecret;
      if (!secret) {
        secret = authenticator.generateSecret();
        await prisma.user.update({
          where: { id: user.id },
          data: { totpSecret: secret, totpEnabled: false },
        });
      }

      if (!code) {
        const otpauthUri = authenticator.keyuri(user.email, "NEO AccessHub", secret);
        const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
          width: 256,
          margin: 2,
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        return res.json({
          requires2FASetup: true,
          preAuthToken: signPreAuthToken(user.id, user.companyId),
          qrCodeDataUrl,
          secret,
        });
      }

      if (!authenticator.check(code, secret)) {
        throw Unauthorized("Código TOTP inválido ou expirado");
      }
      if (!user.totpEnabled) {
        await prisma.user.update({
          where: { id: user.id },
          data: { totpEnabled: true },
        });
      }
    } else if (!code) {
      return res.json({ requires2FA: true, preAuthToken: signPreAuthToken(user.id, user.companyId) });
    } else if (!authenticator.check(code, user.totpSecret)) {
      throw Unauthorized("Código TOTP inválido ou expirado");
    }

    const obraIds = await loadObraIdsForUser({
      userId: user.id,
      companyId: user.companyId,
      permissions,
    });

    const obras = await prisma.obra.findMany({
      where: { companyId: user.companyId, active: true, id: { in: obraIds } },
      select: { id: true, name: true, code: true, city: true, state: true },
      orderBy: { name: "asc" },
    });

    const token = signUserToken({
      id: user.id,
      companyId: user.companyId,
      profile: user.profile,
      email: user.email,
      contractorId: user.contractorId,
      permissions,
      obraIds,
      activeObraId: obras[0]?.id ?? null,
    });

    res.json({
      token,
      serverTime: new Date().toISOString(),
      device: deviceId ? { id: deviceId, name: deviceName ?? null } : null,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profile: user.profile,
        companyId: user.companyId,
        company: user.company,
        permissions,
        obras,
      },
    });
  }),
);

export const authRoutes = router;
