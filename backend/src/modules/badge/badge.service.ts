import QRCode from "qrcode";
import { DocumentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { NotFound } from "../../lib/errors.js";
import { NEO_QR_SPEC } from "../../utils/access-hash.js";

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
    /** Data de emissão (ou validade) do ASO mais recente aprovado. */
    asoLastDate: string | null;
    asoExpiresAt: string | null;
    /** Se o colaborador está apto na NR-35 (doc aprovado e não vencido). */
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
    /** Token NEO- do colaborador (padrão NEO-0A0AA0). */
    token: string;
    /** Conteúdo codificado no QR Code — igual ao token. */
    qrContent: string;
    /** Especificação do formato para integração externa. */
    format: typeof NEO_QR_SPEC.pattern;
    /** Imagem do QR Code em Data URL base64 (image/png). */
    qrCodeDataUrl: string;
    status: "VALIDO" | "BLOQUEADO" | "PENDENTE";
    validUntil: string | null;
  };
  /** Documentos aprovados resumidos para exibição no verso/painel do crachá. */
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
   * Gera o payload completo do crachá para um Worker:
   * - usa o token NEO- persistido como conteúdo do QR;
   * - renderiza o QR Code como Data URL base64;
   * - resume documentação e validade.
   */
  async generate(companyId: string, workerId: string): Promise<BadgePayload> {
    const worker = await prisma.worker.findFirst({
      where: { id: workerId, companyId },
      include: {
        contractor: true,
        company: true,
        function: true,
        documents: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!worker) throw NotFound("Colaborador não encontrado");

    const token = worker.qrHash;
    const qrContent = token;

    // 3) Renderiza o QR como base64 (Data URL PNG).
    const qrCodeDataUrl = await QRCode.toDataURL(qrContent, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#0f172a", light: "#ffffff" },
    });

    // 4) Determina status de acesso.
    const now = new Date();
    const hasRejected = worker.documents.some(
      (d) => d.status === DocumentStatus.REJEITADO,
    );
    const expired =
      worker.accessValidUntil != null && worker.accessValidUntil < now;
    let status: BadgePayload["access"]["status"] = "VALIDO";
    if (worker.status === "BLOCKED" || hasRejected || expired) {
      status = "BLOQUEADO";
    } else if (
      worker.documents.some((d) => d.status === DocumentStatus.PENDENTE)
    ) {
      status = "PENDENTE";
    }

    // 5) Resumo ASO / NR-35 (documentos aprovados mais recentes).
    const approvedByType = (type: string) =>
      worker.documents
        .filter((d) => d.type === type && d.status === DocumentStatus.APROVADO)
        .sort(
          (a, b) =>
            (b.issuedAt?.getTime() ?? b.createdAt.getTime()) -
            (a.issuedAt?.getTime() ?? a.createdAt.getTime()),
        )[0];

    const aso = approvedByType("ASO");
    const nr35 = approvedByType("NR_35");
    const nr35Apto =
      !!nr35 && (!nr35.expiresAt || nr35.expiresAt >= now);

    return {
      worker: {
        id: worker.id,
        fullName: worker.fullName,
        cpf: worker.cpf,
        role: worker.role,
        functionName: worker.function?.name ?? null,
        registration: worker.registration,
        photoUrl: worker.photoUrl,
        initials: buildInitials(worker.fullName),
      },
      health: {
        asoLastDate: aso
          ? (aso.issuedAt ?? aso.createdAt).toISOString()
          : null,
        asoExpiresAt: aso?.expiresAt ? aso.expiresAt.toISOString() : null,
        nr35Apto,
        nr35ExpiresAt: nr35?.expiresAt ? nr35.expiresAt.toISOString() : null,
      },
      contractor: {
        id: worker.contractor.id,
        name: worker.contractor.name,
        legalName: worker.contractor.legalName,
      },
      company: {
        id: worker.company.id,
        name: worker.company.name,
        siteName: worker.company.siteName,
      },
      access: {
        token,
        qrContent,
        format: NEO_QR_SPEC.pattern,
        qrCodeDataUrl,
        status,
        validUntil: worker.accessValidUntil
          ? worker.accessValidUntil.toISOString()
          : null,
      },
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
