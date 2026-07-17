import QRCode from "qrcode";
import { DocumentStatus, DocumentType } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { NotFound } from "../../lib/errors.js";
import { decrypt } from "../../lib/crypto.js";
import { workerScopeWhere, type AuthScope } from "../../lib/scope.js";
import { buildSignedQrPayload, NEO_QR_SPEC } from "../../utils/access-hash.js";

/**
 * Estrutura serializável do crachá. Pensada para ser consumida tanto pelo
 * frontend (render + html2canvas/jsPDF) quanto por um gerador de PDF no backend.
 */
export interface BadgePayload {
  worker: {
    id: string;
    fullName: string;
    cpf: string;
    role: string;
    /** Função cadastrada (catálogo), quando vinculada. */
    functionName: string | null;
    registration: string | null;
    photoUrl: string | null;
    /** Iniciais para fallback de avatar (ex.: "JS"). */
    initials: string;
  };
  /** Resumo de saúde/segurança para o crachá. */
  health: {
    asoLastDate: string | null;
    asoExpiresAt: string | null;
    nr35Apto: boolean;
    nr35ExpiresAt: string | null;
  };
  contractor: {
    id: string;
    name: string;
    legalName: string | null;
  };
  company: {
    id: string;
    name: string;
    siteName: string | null;
  };
  access: {
    token: string;
    qrContent: string;
    format: typeof NEO_QR_SPEC.pattern;
    qrCodeDataUrl: string;
    status: "VALIDO" | "BLOQUEADO" | "PENDENTE";
    validUntil: string | null;
  };
  /** Obras onde o colaborador está ativo. */
  obras: Array<{ id: string; name: string }>;
  documents: Array<{
    type: string;
    title: string | null;
    status: DocumentStatus;
    issuedAt: string | null;
    expiresAt: string | null;
  }>;
  generatedAt: string;
}

function buildInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

export class BadgeService {
  /**
   * Gera o payload completo do crachá para um Worker.
   * Usa o primeiro assignment ativo para dados de função/empreiteira.
   * Se obraId for fornecido, prioriza o assignment daquela obra.
   */
  async generate(
    scope: AuthScope,
    workerId: string,
    obraId?: string,
  ): Promise<BadgePayload> {
    // workerScopeWhere limita ao tenant E às obras/empreiteira do usuário —
    // impede que um usuário de uma obra acesse crachás de outra.
    const worker = await prisma.worker.findFirst({
      where: { id: workerId, ...workerScopeWhere(scope) },
      include: {
        company: true,
        assignments: {
          include: {
            contractor: true,
            function: true,
            obra: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        documents: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!worker) throw NotFound("Colaborador não encontrado");

    // Prioriza o assignment da obra especificada, senão pega o primeiro ativo
    const assignment = obraId
      ? worker.assignments.find((a) => a.obraId === obraId && a.status === "ACTIVE")
      : worker.assignments.find((a) => a.status === "ACTIVE") ?? worker.assignments[0];

    if (!assignment) throw NotFound("Colaborador sem vínculo com obra");

    const token = worker.qrHash;
    // O QR impresso carrega o payload assinado (HMAC) — um crachá reproduzido
    // a partir de um token adivinhado/forjado não passa na verificação do scan.
    const qrCodeDataUrl = await QRCode.toDataURL(buildSignedQrPayload(token), {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    const now = new Date();

    // Status do acesso baseado no assignment selecionado
    const hasRejected = worker.documents.some(
      (d) => d.status === DocumentStatus.REJEITADO,
    );
    const expired = assignment.accessValidUntil != null && assignment.accessValidUntil < now;
    let status: BadgePayload["access"]["status"] = "VALIDO";
    if (assignment.status === "BLOCKED" || hasRejected || expired) {
      status = "BLOQUEADO";
    } else if (worker.documents.some((d) => d.status === DocumentStatus.PENDENTE)) {
      status = "PENDENTE";
    }

    // ASO / NR-35 por título do documento
    const approvedByKeyword = (keyword: RegExp) =>
      worker.documents
        .filter(
          (d) =>
            d.type === DocumentType.SAFETY &&
            d.status === DocumentStatus.APROVADO &&
            keyword.test(d.title ?? ""),
        )
        .sort(
          (a, b) =>
            (b.issuedAt?.getTime() ?? b.createdAt.getTime()) -
            (a.issuedAt?.getTime() ?? a.createdAt.getTime()),
        )[0];

    const aso = approvedByKeyword(/\bASO\b/i);
    const nr35 = approvedByKeyword(/NR[\s-]?35/i);
    const nr35Apto = !!nr35 && (!nr35.expiresAt || nr35.expiresAt >= now);

    const obras = worker.assignments
      .filter((a) => a.status === "ACTIVE")
      .map((a) => ({ id: a.obraId, name: a.obra.name }));

    return {
      worker: {
        id: worker.id,
        fullName: worker.fullName,
        cpf: decrypt(worker.cpf),
        role: assignment.role,
        functionName: assignment.function?.name ?? null,
        registration: assignment.registration,
        photoUrl: worker.photoUrl,
        initials: buildInitials(worker.fullName),
      },
      health: {
        asoLastDate: aso ? (aso.issuedAt ?? aso.createdAt).toISOString() : null,
        asoExpiresAt: aso?.expiresAt ? aso.expiresAt.toISOString() : null,
        nr35Apto,
        nr35ExpiresAt: nr35?.expiresAt ? nr35.expiresAt.toISOString() : null,
      },
      contractor: {
        id: assignment.contractor.id,
        name: assignment.contractor.name,
        legalName: assignment.contractor.legalName,
      },
      company: {
        id: worker.company.id,
        name: worker.company.name,
        siteName: worker.company.siteName,
      },
      access: {
        token,
        qrContent: token,
        format: NEO_QR_SPEC.pattern,
        qrCodeDataUrl,
        status,
        validUntil: assignment.accessValidUntil
          ? assignment.accessValidUntil.toISOString()
          : null,
      },
      obras,
      documents: worker.documents.map((d) => ({
        type: d.type,
        title: d.title,
        status: d.status,
        issuedAt: d.issuedAt ? d.issuedAt.toISOString() : null,
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      })),
      generatedAt: now.toISOString(),
    };
  }
}

export const badgeService = new BadgeService();
