import { Router, type Request } from "express";
import { z } from "zod";
import {
  DocumentType,
  Prisma,
  RequirementCollectionStatus,
  RequirementFrequency,
  RequirementSource,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { NotFound, Unauthorized } from "../../lib/errors.js";
import { requirementsService } from "../requirements/requirements.service.js";
import {
  contractorScopeWhere,
  ensureObraAccess,
  requiredObraId,
  scopeFromRequest,
} from "../../lib/scope.js";

const router = Router();
router.use(authenticate);

const upsertSchema = z.object({
  obraId: z.string().trim().optional(),
  // null = remove o tipo; undefined = não alterar
  typeId: z.string().trim().nullable().optional(),
  name: z.string().trim().min(2),
  legalName: z.string().trim().nullable().optional(),
  cnpj: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .nullable()
    .optional(),
  email: z
    .string()
    .trim()
    .email()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  phone: z.string().trim().nullable().optional(),
  active: z.coerce.boolean().optional(),
});

const dateLike = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
    message: "Data inválida",
  })
  .transform((v) => (v ? new Date(v) : undefined));

const addManualRequirementSchema = z
  .object({
    name: z.string().trim().min(2),
    documentType: z.nativeEnum(DocumentType),
    frequency: z.nativeEnum(RequirementFrequency),
    monthlyDueDay: z.coerce.number().int().min(1).max(31).optional(),
    referenceDate: dateLike,
  })
  .refine(
    (d) =>
      d.frequency === RequirementFrequency.ONE_TIME ||
      (d.frequency === RequirementFrequency.MONTHLY && !!d.monthlyDueDay),
    {
      message: "Para cobrança mensal, informe `monthlyDueDay`.",
      path: ["monthlyDueDay"],
    },
  );

const setApplicabilitySchema = z.object({
  status: z.enum([
    RequirementCollectionStatus.NOT_APPLICABLE,
    RequirementCollectionStatus.NOT_SENT,
  ]),
  naReason: z.string().trim().min(2).optional(),
});

function companyId(req: Request): string {
  if (!req.user) throw Unauthorized();
  return req.user.companyId;
}

const listQuerySchema = z.object({
  name: z.string().optional(),
  legalName: z.string().optional(),
  cnpj: z.string().optional(),
  email: z.string().optional(),
  typeId: z.string().optional(),
  active: z.enum(["true", "false"]).optional(),
  search: z.string().optional(),
});

function tokenize(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

/**
 * Pré-filtra IDs de contractors que casam com a busca textual usando
 * `unaccent` do Postgres. Cada token é AND, em qualquer ordem, sem se
 * importar com acento ou caixa.
 */
async function contractorIdsMatchingText(params: {
  companyId: string;
  obraIds: string[];
  perFieldText: Array<{ field: "name" | "legalName" | "email"; raw: string }>;
  globalRaw?: string;
}): Promise<string[]> {
  const values: string[] = [];
  let i = 1;
  const ands: string[] = [];

  for (const { field, raw } of params.perFieldText) {
    for (const t of tokenize(raw)) {
      ands.push(`unaccent(lower(coalesce("${field}", ''))) LIKE unaccent(lower($${i}))`);
      values.push(`%${t}%`);
      i += 1;
    }
  }

  if (params.globalRaw) {
    for (const t of tokenize(params.globalRaw)) {
      const digits = t.replace(/\D/g, "");
      const or: string[] = [];
      or.push(`unaccent(lower("name")) LIKE unaccent(lower($${i}))`);
      values.push(`%${t}%`);
      i += 1;
      or.push(`unaccent(lower(coalesce("legalName", ''))) LIKE unaccent(lower($${i}))`);
      values.push(`%${t}%`);
      i += 1;
      if (digits.length > 0) {
        or.push(`coalesce("cnpj", '') LIKE $${i}`);
        values.push(`%${digits}%`);
        i += 1;
      }
      ands.push(`(${or.join(" OR ")})`);
    }
  }

  if (ands.length === 0) return [];

  const companyParam = `$${i}`;
  values.push(params.companyId);
  i += 1;

  let obraClause = "";
  if (params.obraIds.length > 0) {
    const placeholders = params.obraIds.map((_, k) => `$${i + k}`).join(",");
    obraClause = ` AND "obraId" IN (${placeholders})`;
    values.push(...params.obraIds);
    i += params.obraIds.length;
  }

  const sql = `SELECT id FROM "contractors"
    WHERE "companyId" = ${companyParam}${obraClause}
      AND ${ands.join(" AND ")}`;
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(sql, ...values);
  return rows.map((r) => r.id);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const q = listQuerySchema.parse(req.query);
    const cnpjDigits = q.cnpj?.replace(/\D/g, "") || undefined;

    const perFieldText: Array<{ field: "name" | "legalName" | "email"; raw: string }> = [];
    if (q.name) perFieldText.push({ field: "name", raw: q.name });
    if (q.legalName) perFieldText.push({ field: "legalName", raw: q.legalName });
    if (q.email) perFieldText.push({ field: "email", raw: q.email });

    let textIds: string[] | null = null;
    if (perFieldText.length > 0 || q.search) {
      const obraIds = scope.activeObraId
        ? [scope.activeObraId]
        : (scope.obraIds ?? []);
      textIds = await contractorIdsMatchingText({
        companyId: scope.companyId,
        obraIds,
        perFieldText,
        globalRaw: q.search,
      });
      if (textIds.length === 0) {
        res.json({ items: [] });
        return;
      }
    }

    const items = await prisma.contractor.findMany({
      where: {
        ...contractorScopeWhere(scope),
        ...(cnpjDigits ? { cnpj: { contains: cnpjDigits } } : {}),
        ...(q.typeId ? { typeId: q.typeId } : {}),
        ...(q.active !== undefined ? { active: q.active === "true" } : {}),
        ...(textIds !== null ? { id: { in: textIds } } : {}),
      },
      orderBy: { name: "asc" },
      include: {
        obra: { select: { id: true, name: true } },
        type: { select: { id: true, name: true } },
        _count: { select: { workers: true, documents: true } },
      },
    });
    res.json({ items });
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const item = await prisma.contractor.findFirst({
      where: { id: String(req.params.id), ...contractorScopeWhere(scope) },
      include: {
        workers: true,
        documents: true,
        type: true,
        obra: { select: { id: true, name: true } },
        requirementItems: true,
      },
    });
    if (!item) throw NotFound("Empreiteira não encontrada");
    res.json(item);
  }),
);

router.post(
  "/",
  requireCapability("fornecedores.manage"),
  asyncHandler(async (req, res) => {
    const data = upsertSchema.parse(req.body);
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    const obraId = data.obraId ?? requiredObraId(scope);
    await ensureObraAccess(scope, obraId);

    const created = await prisma.$transaction(async (tx) => {
      if (data.typeId) {
        const type = await tx.contractorType.findFirst({
          where: { id: data.typeId, companyId: companyIdValue, active: true },
          select: { id: true },
        });
        if (!type) throw NotFound("Tipo de fornecedor não encontrado");
      }

      const contractor = await tx.contractor.create({
        data: {
          companyId: companyIdValue,
          obraId,
          typeId: data.typeId,
          name: data.name,
          legalName: data.legalName,
          cnpj: data.cnpj,
          email: data.email || undefined,
          phone: data.phone,
        },
      });

      if (contractor.typeId) {
        await requirementsService.syncContractorRequirementsForType(tx, {
          companyId: companyIdValue,
          contractorId: contractor.id,
          contractorTypeId: contractor.typeId,
          createdById: req.user?.id,
        });
      }

      return contractor;
    });
    res.status(201).json(created);
  }),
);

router.patch(
  "/:id",
  requireCapability("fornecedores.manage"),
  asyncHandler(async (req, res) => {
    const data = upsertSchema.partial().parse(req.body);
    const id = String(req.params.id);
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    // Valida acesso à nova obra antes de entrar na transação.
    if (data.obraId) await ensureObraAccess(scope, data.obraId);

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.contractor.findFirst({
        where: { id, ...contractorScopeWhere(scope) },
        select: { id: true, obraId: true },
      });
      if (!existing) throw NotFound("Empreiteira não encontrada");

      if (data.typeId) {
        const type = await tx.contractorType.findFirst({
          where: { id: data.typeId, companyId: companyIdValue, active: true },
          select: { id: true },
        });
        if (!type) throw NotFound("Tipo de fornecedor não encontrado");
      }

      const contractor = await tx.contractor.update({
        where: { id },
        data: {
          ...data,
          // null limpa o campo; undefined não toca
          typeId:    data.typeId    === undefined ? undefined : (data.typeId    ?? null),
          legalName: data.legalName === undefined ? undefined : (data.legalName ?? null),
          cnpj:      data.cnpj      === undefined ? undefined : (data.cnpj      ?? null),
          email:     data.email     === undefined ? undefined : (data.email     ?? null),
          phone:     data.phone     === undefined ? undefined : (data.phone     ?? null),
        },
        include: {
          obra: { select: { id: true, name: true } },
          type: { select: { id: true, name: true } },
          _count: { select: { workers: true } },
        },
      });

      // Se a obra mudou, atualiza o obraId de todos os workers desta empreiteira.
      if (data.obraId && data.obraId !== existing.obraId) {
        await tx.worker.updateMany({
          where: { contractorId: id, companyId: companyIdValue },
          data: { obraId: data.obraId },
        });
      }

      if (contractor.typeId) {
        await requirementsService.syncContractorRequirementsForType(tx, {
          companyId: companyIdValue,
          contractorId: contractor.id,
          contractorTypeId: contractor.typeId,
          createdById: req.user?.id,
        });
      }

      return contractor;
    });
    res.json(updated);
  }),
);

router.get(
  "/:id/requirements",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    const contractorId = String(req.params.id);
    const contractor = await prisma.contractor.findFirst({
      where: { id: contractorId, ...contractorScopeWhere(scope) },
      select: { id: true },
    });
    if (!contractor) throw NotFound("Empreiteira não encontrada");

    const items = await prisma.contractorRequirementItem.findMany({
      where: { companyId: companyIdValue, contractorId },
      include: {
        requirement: true,
        latestDocument: {
          select: {
            id: true,
            status: true,
            title: true,
            type: true,
            fileUrl: true,
            issuedAt: true,
            expiresAt: true,
            rejectionReason: true,
            uploadedById: true,
            uploadedBy: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items });
  }),
);

router.post(
  "/:id/requirements/manual",
  requireCapability("colaboradores.manage", "fornecedores.manage"),
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    const contractorId = String(req.params.id);
    const data = addManualRequirementSchema.parse(req.body);

    const contractor = await prisma.contractor.findFirst({
      where: { id: contractorId, ...contractorScopeWhere(scope) },
      select: { id: true },
    });
    if (!contractor) throw NotFound("Empreiteira não encontrada");

    const item = await prisma.contractorRequirementItem.create({
      data: {
        companyId: companyIdValue,
        contractorId,
        source: RequirementSource.MANUAL,
        status: RequirementCollectionStatus.NOT_SENT,
        name: data.name,
        documentType: data.documentType,
        frequency: data.frequency,
        monthlyDueDay: data.monthlyDueDay,
        referenceDate: data.referenceDate,
        createdById: req.user?.id,
      },
    });
    res.status(201).json(item);
  }),
);

router.patch(
  "/:id/requirements/:itemId/applicability",
  requireCapability("documentos.mark_na"),
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const companyIdValue = scope.companyId;
    const contractorId = String(req.params.id);
    const itemId = String(req.params.itemId);
    const data = setApplicabilitySchema.parse(req.body);

    const contractor = await prisma.contractor.findFirst({
      where: { id: contractorId, ...contractorScopeWhere(scope) },
      select: { id: true },
    });
    if (!contractor) throw NotFound("Empreiteira não encontrada");

    const item = await prisma.contractorRequirementItem.findFirst({
      where: { id: itemId, contractorId, companyId: companyIdValue },
      select: { id: true },
    });
    if (!item) throw NotFound("Exigência do fornecedor não encontrada");

    const updated = await prisma.contractorRequirementItem.update({
      where: { id: itemId },
      data: {
        status: data.status,
        naReason:
          data.status === RequirementCollectionStatus.NOT_APPLICABLE
            ? data.naReason ?? "N/A informado no cadastro"
            : null,
      },
    });
    res.json(updated);
  }),
);

export const contractorRoutes = router;
