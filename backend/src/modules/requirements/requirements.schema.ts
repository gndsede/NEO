import { z } from "zod";
import {
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

export const requirementDefinitionUpsertSchema = z
  .object({
    target: z.nativeEnum(RequirementTarget),
    name: z.string().trim().min(2, "Nome do registro é obrigatório"),
    documentType: z.nativeEnum(DocumentType),
    frequency: z.nativeEnum(RequirementFrequency),
    monthlyDueDay: z.coerce.number().int().min(1).max(31).optional(),
    referenceDate: dateLike,
    active: z.coerce.boolean().optional(),
  })
  .refine(
    (d) =>
      d.frequency === RequirementFrequency.ONE_TIME ||
      (d.frequency === RequirementFrequency.MONTHLY && !!d.monthlyDueDay),
    {
      message: "Para frequência mensal, informe `monthlyDueDay` (1-31).",
      path: ["monthlyDueDay"],
    },
  );

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

export const copyRequirementsSchema = z.object({
  sourceId: z.string().min(1, "Selecione a origem"),
  targetId: z.string().min(1, "Selecione o destino"),
  mode: z.enum(["merge", "replace"]).default("merge"),
});

export type CopyRequirementsInput = z.infer<typeof copyRequirementsSchema>;
