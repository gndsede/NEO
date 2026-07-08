import { z } from "zod";
import {
  CompetenceMode,
  DocumentType,
  RequirementFrequency,
  RequirementTarget,
} from "@prisma/client";

const dateLike = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
    message: "Data inválida",
  })
  .transform((v) => (v ? new Date(v) : undefined));

export const requirementDefinitionUpsertSchema = z.object({
  target: z.nativeEnum(RequirementTarget),
  name: z.string().trim().min(2, "Nome do registro é obrigatório"),
  description: z.string().trim().optional(),
  documentType: z.nativeEnum(DocumentType),
  frequency: z.nativeEnum(RequirementFrequency),
  monthlyDueDay: z.coerce.number().int().min(1).max(31).optional(),
  referenceDate: dateLike,
  attachmentFormats: z.string().trim().optional(),
  attachmentRequired: z.coerce.boolean().optional(),
  competenceMode: z.nativeEnum(CompetenceMode).optional(),
  observations: z.string().trim().optional(),
  grantsTurnstileAccess: z.coerce.boolean().optional(),
  active: z.coerce.boolean().optional(),
});

export const listDefinitionQuerySchema = z.object({
  target: z.nativeEnum(RequirementTarget).optional(),
  active: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export const requirementIdsSchema = z.object({
  requirementIds: z.array(z.string().min(1)).default([]),
});

export const workerFunctionUpsertSchema = z.object({
  name: z.string().trim().min(2),
  description: z.string().trim().optional(),
  active: z.coerce.boolean().optional(),
  requirementIds: z.array(z.string().min(1)).optional(),
});

export const contractorTypeUpsertSchema = z.object({
  name: z.string().trim().min(2),
  description: z.string().trim().optional(),
  active: z.coerce.boolean().optional(),
  requirementIds: z.array(z.string().min(1)).optional(),
});

export type RequirementDefinitionUpsertInput = z.infer<
  typeof requirementDefinitionUpsertSchema
>;
export type ListDefinitionQuery = z.infer<typeof listDefinitionQuerySchema>;
export type WorkerFunctionUpsertInput = z.infer<typeof workerFunctionUpsertSchema>;
export type ContractorTypeUpsertInput = z.infer<typeof contractorTypeUpsertSchema>;

/** Linha de importação em lote para catálogos simples (nome + descrição). */
export const importNameDescRowSchema = z.object({
  name: z.string().trim().min(2, "Nome é obrigatório"),
  description: z.string().trim().optional(),
});

export const importRowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "Envie ao menos uma linha"),
});

export const importDefinitionRowSchema = z.object({
  target: z.enum(["WORKER", "CONTRACTOR"]),
  name: z.string().trim().min(2, "Nome do registro é obrigatório"),
  description: z.string().trim().optional(),
  documentType: z.nativeEnum(DocumentType),
  frequency: z.nativeEnum(RequirementFrequency).default(RequirementFrequency.ONE_TIME),
  monthlyDueDay: z.coerce.number().int().min(1).max(31).optional(),
  referenceDate: dateLike,
});

export type ImportNameDescRow = z.infer<typeof importNameDescRowSchema>;
export type ImportDefinitionRow = z.infer<typeof importDefinitionRowSchema>;

export const definitionAccessSchema = z.object({
  groupIds: z.array(z.string().min(1)).default([]),
  userIds: z.array(z.string().min(1)).default([]),
});

export type DefinitionAccessInput = z.infer<typeof definitionAccessSchema>;

export const copyRequirementsSchema = z.object({
  sourceId: z.string().min(1, "Selecione a origem"),
  targetId: z.string().min(1, "Selecione o destino"),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

export type CopyRequirementsInput = z.infer<typeof copyRequirementsSchema>;
