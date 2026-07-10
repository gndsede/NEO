import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { loginRateLimit } from "../../middleware/rate-limit.js";
import { BadRequest, Unauthorized, NotFound } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { fullPermissions } from "../../lib/permissions.js";
import { sendTenantInviteEmail } from "../../lib/invite-email.js";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      saAdminId?: string;
    }
  }
}

const router = Router();

// ---------------------------------------------------------------------------
// JWT helpers (audience "super-admin")
// ---------------------------------------------------------------------------

function signSaToken(adminId: string): string {
  return jwt.sign({ sub: adminId, aud: "super-admin" }, env.JWT_SECRET, {
    expiresIn: "12h",
  });
}

function signSaPreAuthToken(adminId: string): string {
  return jwt.sign({ sub: adminId, aud: "sa-pre-auth" }, env.JWT_SECRET, {
    expiresIn: "5m",
  });
}

interface SaClaims { sub: string; aud: string }

function verifySaToken(token: string): SaClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as SaClaims;
    if (decoded.aud !== "super-admin") throw new Error("audience inválido");
    return decoded;
  } catch {
    throw Unauthorized("Token de super-admin inválido ou expirado");
  }
}

function verifySaPreAuth(token: string): SaClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as SaClaims;
    if (decoded.aud !== "sa-pre-auth") throw new Error("audience inválido");
    return decoded;
  } catch {
    throw Unauthorized("Token de pré-autenticação inválido");
  }
}

// Middleware de autenticação do super-admin
function saAuth(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) throw Unauthorized("Token ausente");
  const claims = verifySaToken(auth.slice("Bearer ".length).trim());
  req.saAdminId = claims.sub;
  next();
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyTotpSchema = z.object({
  preAuthToken: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, "Código deve ter 6 dígitos"),
});

const tenantCreateSchema = z.object({
  name: z.string().min(1),
  legalName: z.string().optional(),
  // O frontend chama esse campo de "cnpj" (nome que o usuário reconhece);
  // no banco ele é a coluna "document" (Company.document).
  cnpj: z.string().optional(),
  plan: z.enum(["STARTER", "PROFISSIONAL", "ENTERPRISE"]).optional(),
  workerLimit: z.number().int().positive().nullable().optional(),
  licenseExpiresAt: z.string().datetime().optional(),
  // Alternativa mais amigável ao licenseExpiresAt: duração em meses a partir de hoje.
  licenseMonths: z.number().int().positive().optional(),
  // Primeiro administrador do tenant — recebe um e-mail de convite para definir a senha.
  adminName: z.string().min(1),
  email: z.string().email(),
});

const tenantUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  legalName: z.string().optional(),
  plan: z.enum(["STARTER", "PROFISSIONAL", "ENTERPRISE"]).optional(),
  workerLimit: z.number().int().positive().optional(),
  licenseExpiresAt: z.string().datetime().optional().nullable(),
});

const contractCreateSchema = z.object({
  companyId: z.string().optional(),
  clauses: z.object({
    tenantName: z.string().min(1),
    tenantCnpj: z.string().optional().default(""),
    tenantAddress: z.string().optional().default(""),
    tenantRepName: z.string().optional().default(""),
    tenantRepCpf: z.string().optional().default(""),
    tenantRepRole: z.string().optional().default(""),
    plan: z.string().min(1),
    monthlyValue: z.number().min(0),
    contractMonths: z.number().int().min(1),
    startDate: z.string(),
    workerLimit: z.string().optional().default("Ilimitado"),
    supportSla: z.string().optional().default(""),
    notes: z.string().optional().default(""),
  }),
});

const invoiceCreateSchema = z.object({
  companyId: z.string().optional(),
  description: z.string().min(1),
  amount: z.number().min(0),
  dueDate: z.string().datetime(),
  notes: z.string().optional(),
});

const ticketStatusSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
});

const ticketReplySchema = z.object({
  body: z.string().min(1),
  isInternal: z.boolean().optional().default(false),
  authorEmail: z.string().email().optional(),
  authorName: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Auth routes (sem autenticação)
// ---------------------------------------------------------------------------

// POST /super-admin/auth/login
router.post(
  "/auth/login",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const admin = await prisma.superAdmin.findUnique({ where: { email } });
    if (!admin) throw Unauthorized("Credenciais inválidas");

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) throw Unauthorized("Credenciais inválidas");

    const preAuthToken = signSaPreAuthToken(admin.id);

    // 2FA já ativo: segunda etapa é apenas o código
    if (admin.totpEnabled) {
      return res.json({ requires2FA: true, preAuthToken });
    }

    // 2FA ainda não configurado: enrolamento no próprio login.
    // A ativação ocorre em POST /super-admin/auth/verify-totp.
    const secret = authenticator.generateSecret();
    await prisma.superAdmin.update({
      where: { id: admin.id },
      data: { totpSecret: secret, totpEnabled: false },
    });

    const otpauthUri = authenticator.keyuri(admin.email, "NEO AccessHub (Super Admin)", secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
      width: 256,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    res.json({ requires2FASetup: true, preAuthToken, qrCodeDataUrl, secret });
  }),
);

// POST /super-admin/auth/verify-totp
router.post(
  "/auth/verify-totp",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { preAuthToken, code } = verifyTotpSchema.parse(req.body);
    const claims = verifySaPreAuth(preAuthToken);

    const admin = await prisma.superAdmin.findUnique({ where: { id: claims.sub } });
    if (!admin?.totpSecret) throw Unauthorized("2FA não configurado");

    const valid = authenticator.check(code, admin.totpSecret);
    if (!valid) throw Unauthorized("Código TOTP inválido");

    // Primeiro código válido após o enrolamento no login: ativa o 2FA
    if (!admin.totpEnabled) {
      await prisma.superAdmin.update({
        where: { id: admin.id },
        data: { totpEnabled: true },
      });
    }

    const token = signSaToken(admin.id);
    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name } });
  }),
);

// ---------------------------------------------------------------------------
// Rotas protegidas — exigem token super-admin
// ---------------------------------------------------------------------------

router.use(saAuth);

// GET /super-admin/me — dados do admin autenticado (inclui status do 2FA)
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const admin = await prisma.superAdmin.findUnique({
      where: { id: req.saAdminId! },
      select: { id: true, email: true, name: true, totpEnabled: true },
    });
    if (!admin) throw Unauthorized("Admin não encontrado");
    res.json({ admin });
  }),
);

// ---------------------------------------------------------------------------
// 2FA do super-admin (setup → enable → disable)
// ---------------------------------------------------------------------------

const saTotpCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Código deve ter 6 dígitos"),
});

// GET /super-admin/2fa/setup — gera segredo + QR Code (não ativa ainda)
router.get(
  "/2fa/setup",
  asyncHandler(async (req, res) => {
    const admin = await prisma.superAdmin.findUnique({
      where: { id: req.saAdminId! },
      select: { email: true, totpEnabled: true },
    });
    if (!admin) throw Unauthorized();
    if (admin.totpEnabled) {
      throw BadRequest("2FA já está ativado. Desative-o antes de reconfigurar.");
    }

    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(admin.email, "NEO AccessHub (Super Admin)", secret);
    const qrCodeDataUrl = await QRCode.toDataURL(uri, {
      width: 256,
      margin: 2,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    await prisma.superAdmin.update({
      where: { id: req.saAdminId! },
      data: { totpSecret: secret, totpEnabled: false },
    });

    res.json({ secret, otpauthUri: uri, qrCodeDataUrl });
  }),
);

// POST /super-admin/2fa/enable — confirma o primeiro código e ativa
router.post(
  "/2fa/enable",
  asyncHandler(async (req, res) => {
    const { code } = saTotpCodeSchema.parse(req.body);
    const admin = await prisma.superAdmin.findUnique({
      where: { id: req.saAdminId! },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!admin) throw Unauthorized();
    if (admin.totpEnabled) throw BadRequest("2FA já está ativado.");
    if (!admin.totpSecret) {
      throw BadRequest("Configure o 2FA primeiro via GET /super-admin/2fa/setup.");
    }

    if (!authenticator.check(code, admin.totpSecret)) {
      throw Unauthorized("Código inválido. Verifique o horário do celular e tente novamente.");
    }

    await prisma.superAdmin.update({
      where: { id: req.saAdminId! },
      data: { totpEnabled: true },
    });
    res.json({ success: true, message: "2FA ativado com sucesso." });
  }),
);

// DELETE /super-admin/2fa/disable — desativa após confirmar o código atual
router.delete(
  "/2fa/disable",
  asyncHandler(async (req, res) => {
    const { code } = saTotpCodeSchema.parse(req.body);
    const admin = await prisma.superAdmin.findUnique({
      where: { id: req.saAdminId! },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!admin) throw Unauthorized();
    if (!admin.totpEnabled || !admin.totpSecret) {
      throw BadRequest("2FA não está ativado.");
    }

    if (!authenticator.check(code, admin.totpSecret)) {
      throw Unauthorized("Código TOTP inválido.");
    }

    await prisma.superAdmin.update({
      where: { id: req.saAdminId! },
      data: { totpEnabled: false, totpSecret: null },
    });
    res.json({ success: true, message: "2FA desativado." });
  }),
);

// GET /super-admin/dashboard
router.get(
  "/dashboard",
  asyncHandler(async (_req, res) => {
    const [totalTenants, activeTenants, blockedTenants, recentTenants] = await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { active: true, blocked: false } }),
      prisma.company.count({ where: { blocked: true } }),
      prisma.company.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, name: true, plan: true, createdAt: true, active: true, blocked: true },
      }),
    ]);

    const [pendingInvoices, openTickets, totalContracts] = await Promise.all([
      prisma.saInvoice.count({ where: { status: "PENDING" } }),
      prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
      prisma.saContract.count(),
    ]);

    res.json({
      stats: {
        totalTenants,
        activeTenants,
        blockedTenants,
        pendingInvoices,
        openTickets,
        totalContracts,
      },
      recentTenants,
    });
  }),
);

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

// GET /super-admin/tenants
router.get(
  "/tenants",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;

    const items = await prisma.company.findMany({
      where: search
        ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { document: { contains: search } }] }
        : undefined,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        legalName: true,
        document: true,
        plan: true,
        active: true,
        blocked: true,
        workerLimit: true,
        licenseExpiresAt: true,
        accessToken: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true, workers: true } },
      },
    });

    // Pega o email do primeiro usuário de cada tenant como contato
    const tenantIds = items.map((c) => c.id);

    const firstUsers =
      tenantIds.length > 0
        ? await prisma.user.findMany({
            where: { companyId: { in: tenantIds } },
            distinct: ["companyId"],
            orderBy: { createdAt: "asc" },
            select: { companyId: true, email: true },
          })
        : [];

    const userByCompany = Object.fromEntries(firstUsers.map((u) => [u.companyId, u]));

    const mapped = items.map((c) => ({
      ...c,
      // Alias esperado pelo frontend (rótulo "CNPJ"); nunca undefined, para
      // não quebrar `.includes()` na busca do painel quando o tenant não tiver document.
      cnpj: c.document ?? "",
      status: c.blocked ? "BLOCKED" : c.active ? "ACTIVE" : "PENDING",
      email: userByCompany[c.id]?.email ?? null,
      userCount: c._count.users,
      workerCount: c._count.workers,
    }));

    res.json({ items: mapped, total: mapped.length });
  }),
);

// POST /super-admin/tenants
router.post(
  "/tenants",
  asyncHandler(async (req, res) => {
    const data = tenantCreateSchema.parse(req.body);

    // licenseMonths tem prioridade sobre licenseExpiresAt quando ambos vierem
    // (é o que o formulário do painel envia).
    let licenseExpiresAt: Date | undefined;
    if (data.licenseMonths) {
      licenseExpiresAt = new Date();
      licenseExpiresAt.setMonth(licenseExpiresAt.getMonth() + data.licenseMonths);
    } else if (data.licenseExpiresAt) {
      licenseExpiresAt = new Date(data.licenseExpiresAt);
    }

    const normalizedEmail = data.email.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existingUser) {
      throw BadRequest("Já existe um usuário cadastrado com este e-mail.");
    }

    const inviteToken = randomBytes(32).toString("hex");
    const inviteTokenExpiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    // Placeholder inutilizável — passwordHash é NOT NULL, mas o login fica
    // bloqueado por `active: false` até o convite ser aceito.
    const placeholderPasswordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);

    const { company, user } = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: data.name,
          legalName: data.legalName,
          document: data.cnpj,
          plan: data.plan ?? "STARTER",
          workerLimit: data.workerLimit ?? undefined,
          licenseExpiresAt,
        },
      });

      const user = await tx.user.create({
        data: {
          companyId: company.id,
          name: data.adminName,
          email: normalizedEmail,
          passwordHash: placeholderPasswordHash,
          profile: "USER",
          permissions: fullPermissions(),
          active: false,
          inviteToken,
          inviteTokenExpiresAt,
        },
      });

      return { company, user };
    });

    const inviteSent = await sendTenantInviteEmail({
      recipientEmail: user.email,
      companyName: company.name,
      inviteToken,
    });

    res.status(201).json({ company, inviteSent });
  }),
);

// GET /super-admin/tenants/:id
router.get(
  "/tenants/:id",
  asyncHandler(async (req, res) => {
    const company = await prisma.company.findUnique({
      where: { id: String(req.params.id) },
      include: {
        _count: { select: { users: true, workers: true, obras: true, contractors: true } },
      },
    });
    if (!company) throw NotFound("Tenant não encontrado");
    res.json(company);
  }),
);

// PATCH /super-admin/tenants/:id
router.patch(
  "/tenants/:id",
  asyncHandler(async (req, res) => {
    const data = tenantUpdateSchema.parse(req.body);
    const company = await prisma.company.update({
      where: { id: String(req.params.id) },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.legalName !== undefined && { legalName: data.legalName }),
        ...(data.plan !== undefined && { plan: data.plan }),
        ...(data.workerLimit !== undefined && { workerLimit: data.workerLimit }),
        ...(data.licenseExpiresAt !== undefined && {
          licenseExpiresAt: data.licenseExpiresAt ? new Date(data.licenseExpiresAt) : null,
        }),
      },
    });
    res.json(company);
  }),
);

// POST /super-admin/tenants/:id/block
router.post(
  "/tenants/:id/block",
  asyncHandler(async (req, res) => {
    await prisma.company.update({ where: { id: String(req.params.id) }, data: { blocked: true } });
    res.json({ success: true });
  }),
);

// POST /super-admin/tenants/:id/unblock
router.post(
  "/tenants/:id/unblock",
  asyncHandler(async (req, res) => {
    await prisma.company.update({ where: { id: String(req.params.id) }, data: { blocked: false } });
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------

// GET /super-admin/contracts
router.get(
  "/contracts",
  asyncHandler(async (_req, res) => {
    const items = await prisma.saContract.findMany({
      orderBy: { createdAt: "desc" },
      include: { company: { select: { name: true } } },
    });
    res.json({ items, total: items.length });
  }),
);

// POST /super-admin/contracts
router.post(
  "/contracts",
  asyncHandler(async (req, res) => {
    const { companyId, clauses } = contractCreateSchema.parse(req.body);
    const startDate = new Date(clauses.startDate);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + clauses.contractMonths);

    const contract = await prisma.saContract.create({
      data: {
        companyId: companyId ?? undefined,
        tenantName: clauses.tenantName,
        tenantCnpj: clauses.tenantCnpj,
        plan: clauses.plan,
        monthlyValue: clauses.monthlyValue,
        contractMonths: clauses.contractMonths,
        startDate,
        endDate,
        clauses: clauses as object,
      },
    });
    res.status(201).json(contract);
  }),
);

// PATCH /super-admin/contracts/:id/status
router.patch(
  "/contracts/:id/status",
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(["DRAFT", "SENT", "SIGNED", "CANCELLED"]) }).parse(req.body);
    const contract = await prisma.saContract.update({
      where: { id: String(req.params.id) },
      data: {
        status,
        ...(status === "SIGNED" && { signedAt: new Date() }),
      },
    });
    res.json(contract);
  }),
);

// ---------------------------------------------------------------------------
// Faturas (Invoices)
// ---------------------------------------------------------------------------

// GET /super-admin/invoices
router.get(
  "/invoices",
  asyncHandler(async (req, res) => {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const items = await prisma.saInvoice.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: { dueDate: "asc" },
      include: { company: { select: { name: true } } },
    });
    res.json({ items, total: items.length });
  }),
);

// POST /super-admin/invoices
router.post(
  "/invoices",
  asyncHandler(async (req, res) => {
    const data = invoiceCreateSchema.parse(req.body);
    const invoice = await prisma.saInvoice.create({
      data: {
        companyId: data.companyId ?? undefined,
        description: data.description,
        amount: data.amount,
        dueDate: new Date(data.dueDate),
        notes: data.notes,
      },
    });
    res.status(201).json(invoice);
  }),
);

// POST /super-admin/invoices/:id/mark-paid
router.post(
  "/invoices/:id/mark-paid",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.saInvoice.update({
      where: { id: String(req.params.id) },
      data: { status: "PAID", paidAt: new Date() },
    });
    res.json(invoice);
  }),
);

// ---------------------------------------------------------------------------
// Tickets de Suporte
// ---------------------------------------------------------------------------

// GET /super-admin/tickets
router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const items = await prisma.supportTicket.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        company: { select: { name: true } },
        _count: { select: { replies: true } },
      },
    });
    res.json({ items, total: items.length });
  }),
);

// GET /super-admin/tickets/:id
router.get(
  "/tickets/:id",
  asyncHandler(async (req, res) => {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: String(req.params.id) },
      include: {
        company: { select: { name: true } },
        replies: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!ticket) throw NotFound("Ticket não encontrado");
    res.json(ticket);
  }),
);

// POST /super-admin/tickets/:id/replies
router.post(
  "/tickets/:id/replies",
  asyncHandler(async (req, res) => {
    const { body, isInternal, authorEmail, authorName } = ticketReplySchema.parse(req.body);

    const ticket = await prisma.supportTicket.findUnique({ where: { id: String(req.params.id) } });
    if (!ticket) throw NotFound("Ticket não encontrado");

    const reply = await prisma.ticketReply.create({
      data: {
        ticketId: String(req.params.id),
        body,
        isInternal: isInternal ?? false,
        authorEmail: authorEmail ?? "suporte@neociv.com.br",
        authorName: authorName ?? "NEO Suporte",
      },
    });

    if (ticket.status === "OPEN") {
      await prisma.supportTicket.update({
        where: { id: String(req.params.id) },
        data: { status: "IN_PROGRESS" },
      });
    }

    res.status(201).json(reply);
  }),
);

// PATCH /super-admin/tickets/:id/status
router.patch(
  "/tickets/:id/status",
  asyncHandler(async (req, res) => {
    const { status } = ticketStatusSchema.parse(req.body);
    const ticket = await prisma.supportTicket.update({
      where: { id: String(req.params.id) },
      data: { status },
    });
    res.json(ticket);
  }),
);

export { router as saRoutes };
