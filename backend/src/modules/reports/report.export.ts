import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type { Response } from "express";
import { EffectiveRequirementStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  contractorScopeWhere,
  workerScopeWhere,
  type AuthScope,
} from "../../lib/scope.js";

type Scope = AuthScope;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _logoBuf: Buffer | null = null;
function getLogoBuf(): Buffer | null {
  if (_logoBuf) return _logoBuf;
  try {
    _logoBuf = readFileSync(path.resolve(__dirname, "../../assets/logo-neo.png"));
    return _logoBuf;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pt-BR");
}

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR");
}

const workerStatusLabel: Record<string, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  BLOCKED: "Bloqueado",
};

const effectiveStatusLabel: Record<string, string> = {
  EM_FALTA: "Em falta",
  AGUARDANDO: "Aguardando",
  REPROVADO: "Reprovado",
  VIGENTE: "Vigente",
  PROX_VENCIMENTO: "Próx. vencimento",
  VENCIDO: "Vencido",
  NA: "N/A",
};

const directionLabel: Record<string, string> = {
  ENTRY: "Entrada",
  EXIT: "Saída",
};

const resultLabel: Record<string, string> = {
  GRANTED: "Liberado",
  DENIED: "Negado",
};

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function toXlsx(
  sheetTitle: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  colWidths: number[],
): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws["!cols"] = colWidths.map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, sheetTitle.slice(0, 31));
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function sendXlsx(res: Response, filename: string, buf: Buffer) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.xlsx"`,
  );
  res.send(buf);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const MARGIN = 40;
const ROW_H = 15;
const HEADER_H = 18;
const COL_BG = "#1a3557";
const EVEN_BG = "#f0f4f8";
const ODD_BG = "#ffffff";
const TEXT_COLOR = "#1f2937";

const LOGO_W = 80;
const LOGO_H = 28;
const HEADER_TOP = MARGIN;

function pdfHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle: string,
) {
  const logo = getLogoBuf();
  if (logo) {
    doc.image(logo, MARGIN, HEADER_TOP, { width: LOGO_W, height: LOGO_H, fit: [LOGO_W, LOGO_H] });
    // Texto fica à direita da logo
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(TEXT_COLOR)
      .text(title, MARGIN + LOGO_W + 14, HEADER_TOP + 2);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6b7280")
      .text(subtitle, MARGIN + LOGO_W + 14)
      .text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`, MARGIN + LOGO_W + 14);
    doc.y = HEADER_TOP + LOGO_H + 16;
  } else {
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor(COL_BG)
      .text("NEO - Soluções Civis", MARGIN, HEADER_TOP);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(TEXT_COLOR).text(title);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6b7280")
      .text(subtitle)
      .text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`);
    doc.moveDown(0.8);
  }
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  colWidths: number[],
) {
  const pageBottom = doc.page.height - MARGIN;
  let y = doc.y;

  const drawHeader = (atY: number) => {
    let x = MARGIN;
    for (let i = 0; i < headers.length; i++) {
      doc.fillColor(COL_BG).rect(x, atY, colWidths[i], HEADER_H).fill();
      doc
        .fillColor("white")
        .font("Helvetica-Bold")
        .fontSize(7)
        .text(headers[i], x + 3, atY + 5, {
          width: colWidths[i] - 6,
          lineBreak: false,
        });
      x += colWidths[i];
    }
  };

  drawHeader(y);
  y += HEADER_H;

  for (let r = 0; r < rows.length; r++) {
    if (y + ROW_H > pageBottom) {
      doc.addPage();
      y = MARGIN;
      drawHeader(y);
      y += HEADER_H;
    }

    const bg = r % 2 === 0 ? EVEN_BG : ODD_BG;
    let x = MARGIN;
    for (let i = 0; i < (rows[r]?.length ?? 0); i++) {
      doc.fillColor(bg).rect(x, y, colWidths[i], ROW_H).fill();
      doc
        .fillColor(TEXT_COLOR)
        .font("Helvetica")
        .fontSize(7)
        .text(rows[r][i] ?? "", x + 3, y + 4, {
          width: colWidths[i] - 6,
          lineBreak: false,
        });
      x += colWidths[i];
    }
    y += ROW_H;
  }

  doc.y = y + 8;
}

function makePdf(res: Response, filename: string): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: MARGIN,
    autoFirstPage: true,
    info: { Title: filename, Author: "NEO - Soluções Civis" },
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.pdf"`,
  );
  doc.pipe(res);
  return doc;
}

// ---------------------------------------------------------------------------
// Relatório 1: Colaboradores
// ---------------------------------------------------------------------------

const W_HEADERS = [
  "Nome Completo",
  "CPF",
  "RG",
  "Função",
  "Empreiteira",
  "Obra",
  "Status",
  "Matrícula",
  "Cadastro",
];
const W_PDF = [150, 88, 68, 80, 110, 85, 55, 70, 65];
const W_XLS = [30, 14, 12, 16, 22, 18, 10, 14, 14];

export async function reportWorkers(
  scope: Scope,
  filters: { contractorId?: string; status?: string },
  format: "xlsx" | "pdf",
  res: Response,
): Promise<void> {
  const items = await prisma.worker.findMany({
    where: {
      ...workerScopeWhere(scope),
      ...(filters.contractorId ? { contractorId: filters.contractorId } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
    },
    include: {
      contractor: { select: { name: true } },
      obra: { select: { name: true } },
      function: { select: { name: true } },
    },
    orderBy: [{ contractor: { name: "asc" } }, { fullName: "asc" }],
  });

  const rows = items.map((w) => [
    w.fullName,
    w.cpf,
    w.rg ?? "—",
    w.function?.name ?? w.role,
    w.contractor.name,
    w.obra.name,
    workerStatusLabel[w.status] ?? w.status,
    w.registration ?? "—",
    fmtDate(w.createdAt),
  ]);

  if (format === "xlsx") {
    sendXlsx(res, "colaboradores", toXlsx("Colaboradores", W_HEADERS, rows, W_XLS));
    return;
  }

  const doc = makePdf(res, "colaboradores");
  pdfHeader(doc, "Relatório de Colaboradores", `Total: ${rows.length} colaboradores`);
  drawTable(doc, W_HEADERS, rows, W_PDF);
  doc.end();
}

// ---------------------------------------------------------------------------
// Relatório 2: Conformidade de Documentação
// ---------------------------------------------------------------------------

const C_HEADERS = [
  "Colaborador",
  "CPF",
  "Empreiteira",
  "Documento",
  "Tipo",
  "Situação",
  "Validade",
];
const C_PDF = [160, 88, 120, 140, 70, 95, 80];
const C_XLS = [28, 14, 22, 26, 14, 16, 14];

export async function reportCompliance(
  scope: Scope,
  filters: {
    contractorId?: string;
    effectiveStatus?: EffectiveRequirementStatus[];
  },
  format: "xlsx" | "pdf",
  res: Response,
): Promise<void> {
  const items = await prisma.workerRequirementItem.findMany({
    where: {
      companyId: scope.companyId,
      ...(filters.effectiveStatus?.length
        ? { effectiveStatus: { in: filters.effectiveStatus } }
        : {}),
      worker: {
        ...workerScopeWhere(scope),
        ...(filters.contractorId ? { contractorId: filters.contractorId } : {}),
      },
    },
    include: {
      worker: {
        select: {
          fullName: true,
          cpf: true,
          contractor: { select: { name: true } },
        },
      },
    },
    orderBy: [{ effectiveStatus: "asc" }, { worker: { fullName: "asc" } }],
  });

  const rows = items.map((item) => [
    item.worker.fullName,
    item.worker.cpf,
    item.worker.contractor.name,
    item.name,
    item.documentType,
    effectiveStatusLabel[item.effectiveStatus] ?? item.effectiveStatus,
    fmtDate(item.expiresAt),
  ]);

  if (format === "xlsx") {
    sendXlsx(res, "conformidade", toXlsx("Conformidade", C_HEADERS, rows, C_XLS));
    return;
  }

  const doc = makePdf(res, "conformidade");
  pdfHeader(doc, "Relatório de Conformidade", `Total: ${rows.length} registros`);
  drawTable(doc, C_HEADERS, rows, C_PDF);
  doc.end();
}

// ---------------------------------------------------------------------------
// Relatório 3: Presença / Registro de Acesso
// ---------------------------------------------------------------------------

const A_HEADERS = [
  "Data / Hora",
  "Colaborador",
  "CPF",
  "Empreiteira",
  "Direção",
  "Resultado",
  "Portão",
  "Operador",
];
const A_PDF = [100, 150, 88, 120, 55, 60, 60, 100];
const A_XLS = [18, 28, 14, 22, 12, 12, 12, 18];

export async function reportAccess(
  scope: Scope,
  filters: { from?: Date; to?: Date; obraId?: string },
  format: "xlsx" | "pdf",
  res: Response,
): Promise<void> {
  const items = await prisma.accessLog.findMany({
    where: {
      companyId: scope.companyId,
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
      ...(filters.obraId ? { worker: { obraId: filters.obraId } } : {}),
    },
    include: {
      worker: {
        select: {
          fullName: true,
          cpf: true,
          contractor: { select: { name: true } },
        },
      },
      operator: { select: { name: true } },
    },
    orderBy: { occurredAt: "desc" },
    take: 10_000,
  });

  const rows = items.map((log) => [
    fmtDateTime(log.occurredAt),
    log.worker?.fullName ?? "—",
    log.worker?.cpf ?? "—",
    log.worker?.contractor?.name ?? "—",
    directionLabel[log.direction] ?? log.direction,
    resultLabel[log.result] ?? log.result,
    log.gate ?? "—",
    log.operator?.name ?? "—",
  ]);

  if (format === "xlsx") {
    sendXlsx(res, "presenca", toXlsx("Presença", A_HEADERS, rows, A_XLS));
    return;
  }

  const doc = makePdf(res, "presenca");
  pdfHeader(doc, "Relatório de Presença / Acesso", `Total: ${rows.length} eventos`);
  drawTable(doc, A_HEADERS, rows, A_PDF);
  doc.end();
}

// ---------------------------------------------------------------------------
// Relatório 4: Pendências por Empreiteira
// ---------------------------------------------------------------------------

const P_HEADERS = [
  "Empreiteira",
  "CNPJ",
  "Obra",
  "Colaboradores",
  "Pendências",
  "Documentos em Falta",
];
const P_PDF = [150, 100, 110, 65, 65, 260];
const P_XLS = [28, 16, 20, 14, 14, 50];

const PENDING_STATUSES = [
  EffectiveRequirementStatus.EM_FALTA,
  EffectiveRequirementStatus.AGUARDANDO,
  EffectiveRequirementStatus.REPROVADO,
  EffectiveRequirementStatus.VENCIDO,
];

export async function reportContractorPending(
  scope: Scope,
  filters: { obraId?: string },
  format: "xlsx" | "pdf",
  res: Response,
): Promise<void> {
  const contractors = await prisma.contractor.findMany({
    where: {
      ...contractorScopeWhere(scope),
      ...(filters.obraId ? { obraId: filters.obraId } : {}),
      active: true,
    },
    include: {
      obra: { select: { name: true } },
      _count: { select: { workers: true } },
      workers: {
        select: {
          requirementItems: {
            where: { effectiveStatus: { in: PENDING_STATUSES } },
            select: { name: true },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const rows = contractors.map((c) => {
    const all = c.workers.flatMap((w) => w.requirementItems);
    const unique = [...new Set(all.map((r) => r.name))];
    return [
      c.name,
      c.cnpj ?? "—",
      c.obra.name,
      String(c._count.workers),
      String(all.length),
      unique.join(", ") || "—",
    ];
  });

  if (format === "xlsx") {
    sendXlsx(
      res,
      "pendencias-empreiteiras",
      toXlsx("Pendências por Empreiteira", P_HEADERS, rows, P_XLS),
    );
    return;
  }

  const doc = makePdf(res, "pendencias-empreiteiras");
  pdfHeader(
    doc,
    "Pendências por Empreiteira",
    `Total: ${rows.length} empreiteiras`,
  );
  drawTable(doc, P_HEADERS, rows, P_PDF);
  doc.end();
}
