import { prisma } from "../../lib/prisma.js";
import { BadRequest, Forbidden, NotFound } from "../../lib/errors.js";
import type { AuthScope } from "../../lib/scope.js";
import type { CreateRdoInput, ListRdoQuery, RejectRdoInput, UpdateRdoInput } from "./rdo.schema.js";

function rdoWhere(scope: AuthScope) {
  return { companyId: scope.companyId };
}

function toDateOrNull(v: string | undefined): Date | null {
  return v ? new Date(v) : null;
}

const SELECT_SUMMARY = {
  id: true,
  data: true,
  docNumero: true,
  contratoNumero: true,
  localidade: true,
  turnos: true,
  status: true,
  efetivoIndireta: true,
  efetivoODireta: true,
  equipamentos: true,
  materiais: true,
  obra: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  approvedBy: { select: { id: true, name: true } },
  approvedAt: true,
  rejectionReason: true,
  createdAt: true,
} as const;

export const rdoService = {
  async list(scope: AuthScope, query: ListRdoQuery) {
    const { page, pageSize, obraId, status, from, to } = query;
    const where = {
      ...rdoWhere(scope),
      ...(obraId ? { obraId } : {}),
      ...(status ? { status } : {}),
      ...(from || to
        ? {
            data: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.rdo.count({ where }),
      prisma.rdo.findMany({
        where,
        orderBy: { data: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: SELECT_SUMMARY,
      }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  async getById(scope: AuthScope, id: string) {
    const rdo = await prisma.rdo.findFirst({
      where: { id, ...rdoWhere(scope) },
      include: {
        obra: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    if (!rdo) throw NotFound("RDO não encontrado.");
    return rdo;
  },

  async create(scope: AuthScope, data: CreateRdoInput, createdById?: string) {
    return prisma.rdo.create({
      data: {
        companyId: scope.companyId,
        obraId: data.obraId ?? null,
        contratoNumero: data.contratoNumero,
        docNumero: data.docNumero,
        data: new Date(data.data),
        turnos: data.turnos,
        jornadaTrabalho: data.jornadaTrabalho,
        localidade: data.localidade,
        dataInicio: toDateOrNull(data.dataInicio),
        dataTermino: toDateOrNull(data.dataTermino),
        diasDecorridos: data.diasDecorridos,
        diasRestantes: data.diasRestantes,
        diasAtraso: data.diasAtraso,
        prorrogacao: toDateOrNull(data.prorrogacao),
        climaManha: data.climaManha,
        climaTarde: data.climaTarde,
        climaNoite: data.climaNoite,
        chuvaQuantMm: data.chuvaQuantMm,
        efetivoIndireta: data.efetivoIndireta,
        efetivoODireta: data.efetivoODireta,
        equipamentos: data.equipamentos,
        atividades: data.atividades,
        materiais: data.materiais,
        consideracoesContratada: data.consideracoesContratada,
        consideracoesFiscalizacao: data.consideracoesFiscalizacao,
        fotos: data.fotos,
        arquivos: data.arquivos,
        status: "PENDENTE",
        createdById: createdById ?? null,
      },
    });
  },

  async update(scope: AuthScope, id: string, data: UpdateRdoInput) {
    const existing = await prisma.rdo.findFirst({ where: { id, ...rdoWhere(scope) } });
    if (!existing) throw NotFound("RDO não encontrado.");
    if (existing.status === "APROVADO") {
      throw BadRequest("RDO aprovado não pode ser editado. Reprove-o primeiro.");
    }
    return prisma.rdo.update({
      where: { id },
      data: {
        ...(data.obraId !== undefined ? { obraId: data.obraId ?? null } : {}),
        ...(data.contratoNumero !== undefined ? { contratoNumero: data.contratoNumero } : {}),
        ...(data.docNumero !== undefined ? { docNumero: data.docNumero } : {}),
        ...(data.data !== undefined ? { data: new Date(data.data) } : {}),
        ...(data.turnos !== undefined ? { turnos: data.turnos } : {}),
        ...(data.jornadaTrabalho !== undefined ? { jornadaTrabalho: data.jornadaTrabalho } : {}),
        ...(data.localidade !== undefined ? { localidade: data.localidade } : {}),
        ...(data.dataInicio !== undefined ? { dataInicio: toDateOrNull(data.dataInicio) } : {}),
        ...(data.dataTermino !== undefined ? { dataTermino: toDateOrNull(data.dataTermino) } : {}),
        ...(data.diasDecorridos !== undefined ? { diasDecorridos: data.diasDecorridos } : {}),
        ...(data.diasRestantes !== undefined ? { diasRestantes: data.diasRestantes } : {}),
        ...(data.diasAtraso !== undefined ? { diasAtraso: data.diasAtraso } : {}),
        ...(data.prorrogacao !== undefined ? { prorrogacao: toDateOrNull(data.prorrogacao) } : {}),
        ...(data.climaManha !== undefined ? { climaManha: data.climaManha } : {}),
        ...(data.climaTarde !== undefined ? { climaTarde: data.climaTarde } : {}),
        ...(data.climaNoite !== undefined ? { climaNoite: data.climaNoite } : {}),
        ...(data.chuvaQuantMm !== undefined ? { chuvaQuantMm: data.chuvaQuantMm } : {}),
        ...(data.efetivoIndireta !== undefined ? { efetivoIndireta: data.efetivoIndireta } : {}),
        ...(data.efetivoODireta !== undefined ? { efetivoODireta: data.efetivoODireta } : {}),
        ...(data.equipamentos !== undefined ? { equipamentos: data.equipamentos } : {}),
        ...(data.atividades !== undefined ? { atividades: data.atividades } : {}),
        ...(data.materiais !== undefined ? { materiais: data.materiais } : {}),
        ...(data.consideracoesContratada !== undefined ? { consideracoesContratada: data.consideracoesContratada } : {}),
        ...(data.consideracoesFiscalizacao !== undefined ? { consideracoesFiscalizacao: data.consideracoesFiscalizacao } : {}),
        ...(data.fotos !== undefined ? { fotos: data.fotos } : {}),
        ...(data.arquivos !== undefined ? { arquivos: data.arquivos } : {}),
      },
    });
  },

  async submitForApproval(scope: AuthScope, id: string) {
    const rdo = await prisma.rdo.findFirst({ where: { id, ...rdoWhere(scope) } });
    if (!rdo) throw NotFound("RDO não encontrado.");
    if (rdo.status !== "PENDENTE" && rdo.status !== "REPROVADO") {
      throw BadRequest("Apenas RDOs com status PENDENTE ou REPROVADO podem ser enviados para aprovação.");
    }
    return prisma.rdo.update({
      where: { id },
      data: { status: "AGUARDANDO_APROVACAO", rejectionReason: null },
    });
  },

  async approve(scope: AuthScope, id: string) {
    const rdo = await prisma.rdo.findFirst({ where: { id, ...rdoWhere(scope) } });
    if (!rdo) throw NotFound("RDO não encontrado.");
    if (rdo.status !== "AGUARDANDO_APROVACAO") {
      throw BadRequest("Somente RDOs aguardando aprovação podem ser aprovados.");
    }
    return prisma.rdo.update({
      where: { id },
      data: {
        status: "APROVADO",
        approvedById: scope.id,
        approvedAt: new Date(),
        rejectionReason: null,
      },
    });
  },

  async reject(scope: AuthScope, id: string, input: RejectRdoInput) {
    const rdo = await prisma.rdo.findFirst({ where: { id, ...rdoWhere(scope) } });
    if (!rdo) throw NotFound("RDO não encontrado.");
    if (rdo.status !== "AGUARDANDO_APROVACAO") {
      throw BadRequest("Somente RDOs aguardando aprovação podem ser reprovados.");
    }
    return prisma.rdo.update({
      where: { id },
      data: {
        status: "REPROVADO",
        rejectionReason: input.reason,
        approvedById: null,
        approvedAt: null,
      },
    });
  },

  async remove(scope: AuthScope, id: string) {
    const existing = await prisma.rdo.findFirst({ where: { id, ...rdoWhere(scope) } });
    if (!existing) throw NotFound("RDO não encontrado.");
    if (existing.status === "APROVADO") {
      throw Forbidden("RDO aprovado não pode ser excluído.");
    }
    await prisma.rdo.delete({ where: { id } });
  },
};
