import { z } from "zod";

export const obraUpsertSchema = z.object({
  name: z.string().trim().min(2, "Nome da obra é obrigatório"),
  code: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  addressLine: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  active: z.coerce.boolean().optional(),
});

export const assignUserObrasSchema = z.object({
  obraIds: z.array(z.string().min(1)).min(1, "Selecione ao menos uma obra"),
});

export type ObraUpsertInput = z.infer<typeof obraUpsertSchema>;
