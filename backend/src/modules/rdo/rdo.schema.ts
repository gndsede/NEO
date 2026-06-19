import { z } from "zod";

const efetivItemSchema = z.object({
  empresa: z.string().min(1),
  efetivo: z.coerce.number().int().min(0),
});

const equipamentoItemSchema = z.object({
  equipamento: z.string().min(1),
  quantidade: z.coerce.number().int().min(0),
});

const atividadeItemSchema = z.object({
  atividadeExecutada: z.string().min(1),
  status: z.string().min(1),
});

const materialItemSchema = z.object({
  fornecedor: z.string().min(1),
  material: z.string().min(1),
  nfRecebidas: z.string().optional(),
});

const fotoItemSchema = z.object({
  fileUrl: z.string(),
  fileKey: z.string().optional(),
  caption: z.string().optional(),
});

const arquivoItemSchema = z.object({
  fileUrl: z.string(),
  fileKey: z.string().optional(),
  fileName: z.string().optional(),
});

export const RDO_STATUSES = ["PENDENTE", "AGUARDANDO_APROVACAO", "APROVADO", "REPROVADO"] as const;
export type RdoStatusType = (typeof RDO_STATUSES)[number];

export const createRdoSchema = z.object({
  obraId: z.string().optional(),
  contratoNumero: z.string().optional(),
  docNumero: z.string().optional(),
  data: z.string(),
  turnos: z.string().optional(),
  jornadaTrabalho: z.string().optional(),
  localidade: z.string().optional(),
  dataInicio: z.string().optional(),
  dataTermino: z.string().optional(),
  diasDecorridos: z.coerce.number().int().optional(),
  diasRestantes: z.coerce.number().int().optional(),
  diasAtraso: z.coerce.number().int().optional(),
  prorrogacao: z.string().optional(),
  climaManha: z.string().optional(),
  climaTarde: z.string().optional(),
  climaNoite: z.string().optional(),
  chuvaQuantMm: z.coerce.number().optional(),
  efetivoIndireta: z.array(efetivItemSchema).default([]),
  efetivoODireta: z.array(efetivItemSchema).default([]),
  equipamentos: z.array(equipamentoItemSchema).default([]),
  atividades: z.array(atividadeItemSchema).default([]),
  materiais: z.array(materialItemSchema).default([]),
  consideracoesContratada: z.string().optional(),
  consideracoesFiscalizacao: z.string().optional(),
  fotos: z.array(fotoItemSchema).default([]),
  arquivos: z.array(arquivoItemSchema).default([]),
});

export const updateRdoSchema = createRdoSchema.partial();

export const listRdoSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  obraId: z.string().optional(),
  status: z.enum(RDO_STATUSES).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const rejectRdoSchema = z.object({
  reason: z.string().trim().min(3, "Informe o motivo da reprovação (mínimo 3 caracteres)."),
});

export type CreateRdoInput = z.infer<typeof createRdoSchema>;
export type UpdateRdoInput = z.infer<typeof updateRdoSchema>;
export type ListRdoQuery = z.infer<typeof listRdoSchema>;
export type RejectRdoInput = z.infer<typeof rejectRdoSchema>;
