import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, signUserToken } from "../../middleware/auth.js";
import {
  loginRateLimit,
  publicRateLimit,
  twoFactorRateLimit,
} from "../../middleware/rate-limit.js";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../../lib/errors.js";
import { hasAnyCapability, hasCapability, normalizePermissions } from "../../lib/permissions.js";
import { loadObraIdsForUser } from "../../lib/scope.js";
import { env } from "../../config/env.js";
import { sendPasswordResetEmail } from "../../lib/password-reset-email.js";
import { hashPassword, needsRehash, verifyPassword } from "../../lib/password.js";
import {
  consumeBackupCode,
  generateBackupCodes,
  looksLikeBackupCode,
} from "../../lib/backup-codes.js";
import { recordAudit } from "../../lib/audit.js";

const RESET_PASSWORD_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

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
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as PreAuthClaims;
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

// Aceita código TOTP (6 dígitos) OU código de backup (XXXX-XXXX, uso único).
const login2faSchema = z.object({
  preAuthToken: z.string().min(1),
  code: z.string().trim().min(6).max(12),
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
    if (!user || !user.active) {
      await recordAudit({
        action: "LOGIN_FAILED",
        actorEmail: normalizedEmail,
        ip: req.ip ?? null,
        meta: { flow: "web", reason: "unknown_or_inactive" },
      });
      throw Unauthorized("Credenciais inválidas");
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await recordAudit({
        action: "LOGIN_FAILED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: normalizedEmail,
        ip: req.ip ?? null,
        meta: { flow: "web", reason: "wrong_password" },
      });
      throw Unauthorized("Credenciais inválidas");
    }

    // Re-hash oportunista: eleva hashes antigos (custo 10) para o custo atual
    // sem exigir troca de senha (auditoria F17 — OWASP ASVS V2.4).
    if (needsRehash(user.passwordHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

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

    // Código de backup (uso único) — alternativa para dispositivo TOTP perdido.
    let usedBackupCode = false;
    let newBackupCodes: string[] | null = null;

    if (looksLikeBackupCode(code)) {
      if (!user.totpEnabled) {
        throw Unauthorized("Código TOTP inválido ou expirado");
      }
      const remaining = await consumeBackupCode(code, user.totpBackupCodes);
      if (!remaining) throw Unauthorized("Código de backup inválido ou já utilizado");
      await prisma.user.update({
        where: { id: user.id },
        data: { totpBackupCodes: remaining },
      });
      usedBackupCode = true;
      await recordAudit({
        action: "TWO_FA_BACKUP_CODE_USED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: user.email,
        ip: req.ip ?? null,
        meta: { remainingCodes: remaining.length },
      });
    } else {
      const valid = authenticator.check(code, user.totpSecret);
      if (!valid) throw Unauthorized("Código TOTP inválido ou expirado");
    }

    // Primeiro código válido após o enrolamento no login: ativa o 2FA e gera
    // os códigos de backup (exibidos uma única vez).
    if (!user.totpEnabled) {
      const generated = await generateBackupCodes();
      newBackupCodes = generated.plainCodes;
      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabled: true, totpBackupCodes: generated.hashes },
      });
      await recordAudit({
        action: "TWO_FA_ENABLED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: user.email,
        ip: req.ip ?? null,
        meta: { flow: "web-enrollment" },
      });
    }

    const permissions = normalizePermissions(user.permissions);
    const obraIds = await loadObraIdsForUser({
      userId: user.id,
      companyId: user.companyId,
      permissions,
      allObrasAccess: user.allObrasAccess,
    });

    const obras = await prisma.obra.findMany({
      where: { companyId: user.companyId, active: true, id: { in: obraIds } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });

    // Sessão web mais curta que a do app da catraca (token vive em
    // localStorage — auditoria F08, OWASP ASVS V3).
    const token = signUserToken(
      {
        id: user.id,
        companyId: user.companyId,
        profile: user.profile,
        email: user.email,
        contractorId: user.contractorId,
        permissions,
        obraIds,
        activeObraId: obras[0]?.id ?? null,
        allObrasAccess: user.allObrasAccess,
        // Recalculado a cada requisição em buildAuthUser; não faz parte do JWT.
        allowedDocumentTypes: null,
      },
      { expiresIn: env.JWT_EXPIRES_IN_WEB },
    );

    await recordAudit({
      action: "LOGIN_SUCCESS",
      companyId: user.companyId,
      actorId: user.id,
      actorEmail: user.email,
      ip: req.ip ?? null,
      meta: { flow: "web", usedBackupCode },
    });

    res.json({
      token,
      // Presente apenas no primeiro login após o enrolamento do 2FA —
      // o frontend deve exibir e orientar o usuário a guardar em local seguro.
      ...(newBackupCodes ? { backupCodes: newBackupCodes } : {}),
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
  twoFactorRateLimit,
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

    const backupCodes = await generateBackupCodes();

    await prisma.user.update({
      where: { id: scope.id },
      data: { totpEnabled: true, totpBackupCodes: backupCodes.hashes },
    });

    await recordAudit({
      action: "TWO_FA_ENABLED",
      companyId: scope.companyId,
      actorId: scope.id,
      actorEmail: scope.email,
      ip: req.ip ?? null,
    });

    res.json({
      success: true,
      message: "Autenticação em dois fatores ativada com sucesso.",
      // Exibidos UMA única vez — o usuário deve guardá-los em local seguro.
      backupCodes: backupCodes.plainCodes,
      backupCodesNotice:
        "Guarde estes códigos de backup em local seguro. Cada um pode ser usado uma única vez caso você perca o acesso ao aplicativo autenticador.",
    });
  }),
);

/**
 * POST /auth/2fa/backup-codes
 * Regenera os códigos de backup (invalida todos os anteriores).
 * Exige o código TOTP atual para confirmar a posse do dispositivo.
 */
router.post(
  "/2fa/backup-codes",
  twoFactorRateLimit,
  authenticate,
  asyncHandler(async (req, res) => {
    const scope = req.user!;
    const { code } = totpCodeSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: scope.id },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpEnabled || !user.totpSecret) {
      throw BadRequest("2FA não está ativado.");
    }
    if (!authenticator.check(code, user.totpSecret)) {
      throw Unauthorized("Código TOTP inválido.");
    }

    const backupCodes = await generateBackupCodes();
    await prisma.user.update({
      where: { id: scope.id },
      data: { totpBackupCodes: backupCodes.hashes },
    });

    await recordAudit({
      action: "TWO_FA_BACKUP_CODES_REGENERATED",
      companyId: scope.companyId,
      actorId: scope.id,
      actorEmail: scope.email,
      ip: req.ip ?? null,
    });

    res.json({
      success: true,
      backupCodes: backupCodes.plainCodes,
      backupCodesNotice:
        "Códigos anteriores foram invalidados. Guarde os novos em local seguro.",
    });
  }),
);

/**
 * DELETE /auth/2fa/disable
 * Desativa o 2FA após confirmar com o código atual do Authenticator.
 */
router.delete(
  "/2fa/disable",
  twoFactorRateLimit,
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
      data: { totpEnabled: false, totpSecret: null, totpBackupCodes: [] },
    });

    await recordAudit({
      action: "TWO_FA_DISABLED",
      companyId: scope.companyId,
      actorId: scope.id,
      actorEmail: scope.email,
      ip: req.ip ?? null,
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
  // TOTP (6 dígitos) ou código de backup (XXXX-XXXX).
  code: z.string().trim().min(6).max(12).optional(),
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
    if (!user || !user.active) {
      await recordAudit({
        action: "LOGIN_FAILED",
        actorEmail: normalizedEmail,
        ip: req.ip ?? null,
        meta: { flow: "mobile", reason: "unknown_or_inactive" },
      });
      throw Unauthorized("Credenciais inválidas");
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await recordAudit({
        action: "LOGIN_FAILED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: normalizedEmail,
        ip: req.ip ?? null,
        meta: { flow: "mobile", reason: "wrong_password" },
      });
      throw Unauthorized("Credenciais inválidas");
    }

    // Re-hash oportunista (custo 10 → 12), ver /login.
    if (needsRehash(user.passwordHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    ensureCompanyActive(user.company);

    const permissions = normalizePermissions(user.permissions);

    if (!hasAnyCapability({ permissions }, ["catraca.manage", "catraca.view"])) {
      throw Forbidden(
        "Este usuário não tem permissão para operar a catraca. Peça ao administrador as permissões «Visualizar catraca» ou «Registrar acessos manualmente».",
      );
    }

    // Códigos de backup gerados no enrolamento mobile (exibidos uma única vez).
    let mobileBackupCodes: string[] | null = null;

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
        const generated = await generateBackupCodes();
        mobileBackupCodes = generated.plainCodes;
        await prisma.user.update({
          where: { id: user.id },
          data: { totpEnabled: true, totpBackupCodes: generated.hashes },
        });
        await recordAudit({
          action: "TWO_FA_ENABLED",
          companyId: user.companyId,
          actorId: user.id,
          actorEmail: user.email,
          ip: req.ip ?? null,
          meta: { flow: "mobile-enrollment" },
        });
      }
    } else if (!code) {
      return res.json({ requires2FA: true, preAuthToken: signPreAuthToken(user.id, user.companyId) });
    } else if (looksLikeBackupCode(code)) {
      // Código de backup (uso único) — dispositivo TOTP perdido.
      const remaining = await consumeBackupCode(code, user.totpBackupCodes);
      if (!remaining) throw Unauthorized("Código de backup inválido ou já utilizado");
      await prisma.user.update({
        where: { id: user.id },
        data: { totpBackupCodes: remaining },
      });
      await recordAudit({
        action: "TWO_FA_BACKUP_CODE_USED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: user.email,
        ip: req.ip ?? null,
        meta: { flow: "mobile", remainingCodes: remaining.length },
      });
    } else if (!authenticator.check(code, user.totpSecret)) {
      throw Unauthorized("Código TOTP inválido ou expirado");
    }

    const obraIds = await loadObraIdsForUser({
      userId: user.id,
      companyId: user.companyId,
      permissions,
      allObrasAccess: user.allObrasAccess,
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
      allObrasAccess: user.allObrasAccess,
      allowedDocumentTypes: null,
    });

    await recordAudit({
      action: "LOGIN_MOBILE_SUCCESS",
      companyId: user.companyId,
      actorId: user.id,
      actorEmail: user.email,
      ip: req.ip ?? null,
      meta: { deviceId: deviceId ?? null, deviceName: deviceName ?? null },
    });

    res.json({
      token,
      serverTime: new Date().toISOString(),
      device: deviceId ? { id: deviceId, name: deviceName ?? null } : null,
      ...(mobileBackupCodes ? { backupCodes: mobileBackupCodes } : {}),
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

// ---------------------------------------------------------------------------
// Convite de primeiro acesso (tenant criado pelo super-admin)
// ---------------------------------------------------------------------------

async function findValidInvite(token: string) {
  const user = await prisma.user.findUnique({
    where: { inviteToken: token },
    select: {
      id: true,
      email: true,
      inviteTokenExpiresAt: true,
      company: { select: { name: true } },
    },
  });
  if (!user || !user.inviteTokenExpiresAt || user.inviteTokenExpiresAt < new Date()) {
    return null;
  }
  return user;
}

// GET /auth/invite/:token — valida o convite e devolve dados para a tela de definir senha
router.get(
  "/invite/:token",
  publicRateLimit,
  asyncHandler(async (req, res) => {
    const invite = await findValidInvite(String(req.params.token));
    if (!invite) throw NotFound("Convite inválido ou expirado.");
    res.json({ email: invite.email, companyName: invite.company.name });
  }),
);

const acceptInviteSchema = z.object({
  password: z.string().min(8, "A senha deve ter ao menos 8 caracteres"),
});

// POST /auth/invite/:token — define a senha e ativa a conta
router.post(
  "/invite/:token",
  publicRateLimit,
  asyncHandler(async (req, res) => {
    const invite = await findValidInvite(String(req.params.token));
    if (!invite) throw NotFound("Convite inválido ou expirado.");

    const { password } = acceptInviteSchema.parse(req.body);
    const passwordHash = await hashPassword(password);

    await prisma.user.update({
      where: { id: invite.id },
      data: {
        passwordHash,
        active: true,
        inviteToken: null,
        inviteTokenExpiresAt: null,
      },
    });

    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Esqueci minha senha
// ---------------------------------------------------------------------------

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// POST /auth/forgot-password — gera token e envia e-mail de redefinição.
// Resposta sempre genérica (mesmo se o e-mail não existir), para não permitir
// enumeração de contas cadastradas.
router.post(
  "/forgot-password",
  publicRateLimit,
  asyncHandler(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" }, active: true },
    });

    if (user) {
      const resetPasswordToken = randomBytes(32).toString("hex");
      const resetPasswordTokenExpiresAt = new Date(Date.now() + RESET_PASSWORD_TOKEN_TTL_MS);

      await prisma.user.update({
        where: { id: user.id },
        data: { resetPasswordToken, resetPasswordTokenExpiresAt },
      });

      await sendPasswordResetEmail({
        recipientEmail: user.email,
        resetToken: resetPasswordToken,
      });

      await recordAudit({
        action: "PASSWORD_RESET_REQUESTED",
        companyId: user.companyId,
        actorId: user.id,
        actorEmail: user.email,
        ip: req.ip ?? null,
      });
    }

    res.json({
      success: true,
      message:
        "Se houver uma conta com este e-mail, você receberá um link para redefinir sua senha.",
    });
  }),
);

async function findValidPasswordReset(token: string) {
  const user = await prisma.user.findUnique({
    where: { resetPasswordToken: token },
    select: {
      id: true,
      email: true,
      resetPasswordTokenExpiresAt: true,
    },
  });
  if (
    !user ||
    !user.resetPasswordTokenExpiresAt ||
    user.resetPasswordTokenExpiresAt < new Date()
  ) {
    return null;
  }
  return user;
}

// GET /auth/reset-password/:token — valida o token e devolve dados para a tela de redefinição
router.get(
  "/reset-password/:token",
  publicRateLimit,
  asyncHandler(async (req, res) => {
    const reset = await findValidPasswordReset(String(req.params.token));
    if (!reset) throw NotFound("Link de redefinição inválido ou expirado.");
    res.json({ email: reset.email });
  }),
);

const resetPasswordSchema = z.object({
  password: z.string().min(8, "A senha deve ter ao menos 8 caracteres"),
});

// POST /auth/reset-password/:token — define a nova senha
router.post(
  "/reset-password/:token",
  publicRateLimit,
  asyncHandler(async (req, res) => {
    const reset = await findValidPasswordReset(String(req.params.token));
    if (!reset) throw NotFound("Link de redefinição inválido ou expirado.");

    const { password } = resetPasswordSchema.parse(req.body);
    const passwordHash = await hashPassword(password);

    await prisma.user.update({
      where: { id: reset.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordTokenExpiresAt: null,
      },
    });

    await recordAudit({
      action: "PASSWORD_RESET_COMPLETED",
      actorId: reset.id,
      actorEmail: reset.email,
      ip: req.ip ?? null,
    });

    res.json({ success: true });
  }),
);

export const authRoutes = router;
