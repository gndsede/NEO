import { z } from "zod";
import { DocumentOwnerType, DocumentStatus, DocumentType } from "@prisma/client";

export const rejectDocumentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Informe o motivo da rejeição (auditoria)"),
});

export type RejectDocumentInput = z.infer<typeof rejectDocumentSchema>;

export const approveDocumentSchema = z.object({
  // Opcional: permitir ajustar/validar a data de validade no momento da aprovação.
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().date().optional()),
});

export type ApproveDocumentInput = z.infer<typeof approveDocumentSchema>;

export const listDocumentsQuerySchema = z.object({
  ownerType: z.nativeEnum(DocumentOwnerType).optional(),
  workerId: z.string().optional(),
  contractorId: z.string().optional(),
  status: z.nativeEnum(DocumentStatus).optional(),
  type: z.nativeEnum(DocumentType).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

/** Anexar documento avulso a um Worker ou Contractor (multipart). */
export const attachDocumentSchema = z
  .object({
    ownerType: z.nativeEnum(DocumentOwnerType),
    workerId: z.string().optional(),
    contractorId: z.string().optional(),
    workerRequirementItemId: z.string().optional(),
    contractorRequirementItemId: z.string().optional(),
    type: z.nativeEnum(DocumentType),
    title: z.string().trim().optional(),
    issuedAt: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : undefined)),
    expiresAt: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : undefined)),
  })
  .refine(
    (d) =>
      (d.ownerType === "WORKER" && !!d.workerId) ||
      (d.ownerType === "CONTRACTOR" && !!d.contractorId),
    {
      message:
        "ownerType deve ser coerente com a FK: WORKER exige workerId; CONTRACTOR exige contractorId",
    },
  )
  .refine(
    (d) =>
      (d.ownerType === "WORKER" && !d.contractorRequirementItemId) ||
      (d.ownerType === "CONTRACTOR" && !d.workerRequirementItemId),
    {
      message:
        "ownerType WORKER só aceita workerRequirementItemId; ownerType CONTRACTOR só aceita contractorRequirementItemId.",
    },
  );

export type AttachDocumentInput = z.infer<typeof attachDocumentSchema>;
