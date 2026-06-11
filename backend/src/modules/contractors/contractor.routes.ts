import { Router, type Request } from "express";
import { z } from "zod";
import {
  DocumentType,
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
  typeId: z.string().trim().optional(),
  name: z.string().trim().min(2),
  legalName: z.string().trim().optional(),
  cnpj: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().trim().optional(),
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

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const scope = scopeFromRequest(req);
    const items = await prisma.contractor.findMany({
      where: contractorScopeWhere(scope),
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
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.contractor.findFirst({
        where: { id, ...contractorScopeWhere(scope) },
        select: { id: true },
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
          email: data.email || undefined,
          active: data.active,
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
