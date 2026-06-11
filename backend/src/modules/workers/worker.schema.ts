import { z } from "zod";
import {
  DocumentType,
  RequirementCollectionStatus,
  RequirementFrequency,
  WorkerStatus,
} from "@prisma/client";

/**
 * Em multipart/form-data todos os campos chegam como string.
 * Por isso usamos coerções/transforms tolerantes.
 */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const dateLike = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
    message: "Data inválida (use ISO 8601, ex.: 2026-12-31)",
  })
  .transform((v) => (v ? new Date(v) : undefined));

/**
 * Metadados dos documentos enviados no cadastro. Enviar como JSON string
 * no campo `documentsMeta` (alinhado posicionalmente aos arquivos `documents`).
 * Ex.: documentsMeta = '[{"type":"ASO","expiresAt":"2026-12-31"}, ...]'
 */
export const documentMetaSchema = z.object({
  type: z.nativeEnum(DocumentType),
  title: optionalString,
  issuedAt: dateLike,
  expiresAt: dateLike,
});

export const createWorkerSchema = z.object({
  contractorId: z.string().min(1, "contractorId é obrigatório"),
  functionId: z.string().optional(),
  fullName: z.string().trim().min(3, "Nome completo é obrigatório"),
  cpf: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 11, "CPF deve conter 11 dígitos"),
  rg: optionalString,
  birthDate: dateLike,
  email: z
    .string()
    .trim()
    .email("E-mail inválido")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  phone: optionalString,
  role: z.string().trim().min(2, "Função é obrigatória"),
  registration: optionalString,
  documentsMeta: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw || raw.trim() === "") return [] as z.infer<
        typeof documentMetaSchema
      >[];
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr.map((item) => documentMetaSchema.parse(item));
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "documentsMeta deve ser um JSON válido (array de {type, expiresAt, ...})",
        });
        return z.NEVER;
      }
    }),
});

export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
export type DocumentMeta = z.infer<typeof documentMetaSchema>;

export const updateWorkerSchema = createWorkerSchema
  .omit({ documentsMeta: true, contractorId: true })
  .partial()
  .extend({
    status: z.nativeEnum(WorkerStatus).optional(),
  });

export type UpdateWorkerInput = z.infer<typeof updateWorkerSchema>;

/** Linha de importação em lote (planilha). Resolve empreiteira/função por nome. */
export const importWorkerRowSchema = z.object({
  fullName: z.string().trim().min(3, "Nome completo é obrigatório"),
  cpf: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length === 11, "CPF deve conter 11 dígitos"),
  rg: optionalString,
  birthDate: dateLike,
  email: optionalString,
  phone: optionalString,
  role: z.string().trim().min(2, "Função operacional é obrigatória"),
  registration: optionalString,
  contractorName: z.string().trim().min(1, "Empreiteira é obrigatória"),
  functionName: optionalString,
});

export const importWorkersSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "Envie ao menos uma linha"),
});

export type ImportWorkerRow = z.infer<typeof importWorkerRowSchema>;

export const listWorkersQuerySchema = z.object({
  contractorId: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "BLOCKED"]).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(1000).default(20),
});

export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;

export const addManualWorkerRequirementSchema = z.object({
  name: z.string().trim().min(2, "Nome do registro é obrigatório"),
  documentType: z.nativeEnum(DocumentType),
  frequency: z.nativeEnum(RequirementFrequency),
  monthlyDueDay: z.coerce.number().int().min(1).max(31).optional(),
  referenceDate: dateLike,
});

export type AddManualWorkerRequirementInput = z.infer<
  typeof addManualWorkerRequirementSchema
>;

export const setWorkerRequirementApplicabilitySchema = z.object({
  status: z.enum([
    RequirementCollectionStatus.NOT_APPLICABLE,
    RequirementCollectionStatus.NOT_SENT,
  ]),
  naReason: z.string().trim().min(2).optional(),
});

export type SetWorkerRequirementApplicabilityInput = z.infer<
  typeof setWorkerRequirementApplicabilitySchema
>;
