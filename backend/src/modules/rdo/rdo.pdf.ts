import PDFDocument from "pdfkit";
import type { Rdo, Obra } from "@prisma/client";

type RdoWithRelations = Rdo & {
  obra: Pick<Obra, "name"> | null;
  createdBy: { name: string } | null;
  approvedBy: { name: string } | null;
};

type JsonArray = Array<Record<string, unknown>>;

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pt-BR");
}

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR");
}

function row(arr: unknown): JsonArray {
  if (!Array.isArray(arr)) return [];
  return arr as JsonArray;
}

const CLIMA_LABEL: Record<string, string> = {
  SEM_CHUVA: "Sem chuva", GAROA: "Garoa", CHUVA_FRACA: "Chuva fraca",
  CHUVA_MODERADA: "Chuva moderada", CHUVA_FORTE: "Chuva forte",
};

const ATIV_LABEL: Record<string, string> = {
  EM_ANDAMENTO: "Em andamento", CONCLUIDA: "Concluída",
  PARALISADA: "Paralisada", PENDENTE: "Pendente",
};

const STATUS_LABEL: Record<string, string> = {
  PENDENTE: "PENDENTE",
  AGUARDANDO_APROVACAO: "AGUARDANDO APROVAÇÃO",
  APROVADO: "APROVADO",
  REPROVADO: "REPROVADO",
};

// Page geometry
const MARGIN = 48;
const PAGE_W = 595.28; // A4
const CONTENT_W = PAGE_W - MARGIN * 2;
const COL_GAY = 8;

function sectionTitle(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.6);
  doc
    .rect(MARGIN, doc.y, CONTENT_W, 16)
    .fillColor("#1e1e2e")
    .fill();
  doc
    .fillColor("#a0a0c0")
    .fontSize(7.5)
    .font("Helvetica-Bold")
    .text(title.toUpperCase(), MARGIN + 6, doc.y - 13, { width: CONTENT_W - 12, lineBreak: false });
  doc.fillColor("#1a1a2a").moveDown(0.5);
}

function kv(doc: PDFKit.PDFDocument, pairs: Array<[string, string]>, cols = 3) {
  const colW = (CONTENT_W - COL_GAY * (cols - 1)) / cols;
  let x = MARGIN;
  let startY = doc.y;
  let maxH = 0;

  pairs.forEach(([label, value], idx) => {
    const cy = startY;
    doc
      .fontSize(7)
      .font("Helvetica-Bold")
      .fillColor("#808090")
      .text(label.toUpperCase(), x, cy, { width: colW });
    const afterLabel = doc.y;
    doc
      .fontSize(8.5)
      .font("Helvetica")
      .fillColor("#e0e0e0")
      .text(value || "—", x, afterLabel, { width: colW });
    const h = doc.y - cy;
    if (h > maxH) maxH = h;

    if ((idx + 1) % cols === 0) {
      startY += maxH + 6;
      maxH = 0;
      x = MARGIN;
    } else {
      x += colW + COL_GAY;
    }
  });
  if (pairs.length % cols !== 0) {
    doc.y = startY + maxH + 6;
  }
}

function tableHeader(doc: PDFKit.PDFDocument, cols: Array<{ label: string; width: number }>) {
  const y = doc.y;
  doc.rect(MARGIN, y, CONTENT_W, 14).fillColor("#2a2a3e").fill();
  let x = MARGIN + 4;
  for (const col of cols) {
    doc
      .fontSize(7)
      .font("Helvetica-Bold")
      .fillColor("#9090b0")
      .text(col.label.toUpperCase(), x, y + 3, { width: col.width - 4, lineBreak: false });
    x += col.width;
  }
  doc.y = y + 14;
}

function tableRow(
  doc: PDFKit.PDFDocument,
  cols: Array<{ value: string; width: number }>,
  odd: boolean,
) {
  const y = doc.y;
  if (odd) {
    doc.rect(MARGIN, y, CONTENT_W, 14).fillColor("#18181f").fill();
  }
  let x = MARGIN + 4;
  for (const col of cols) {
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#cccccc")
      .text(col.value || "—", x, y + 3, { width: col.width - 4, lineBreak: false, ellipsis: true });
    x += col.width;
  }
  doc.y = y + 14;
}

export function generateRdoPdf(rdos: RdoWithRelations[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // background
    doc.rect(0, 0, PAGE_W, 841.89).fillColor("#0f0f17").fill();

    // header
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .fillColor("#e0e0f0")
      .text("RELATÓRIO DIÁRIO DE OBRA", MARGIN, MARGIN, { width: CONTENT_W, align: "center" });

    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#707080")
      .text(`Gerado em ${fmtDateTime(new Date())}`, MARGIN, doc.y + 2, {
        width: CONTENT_W,
        align: "center",
      });

    doc.moveDown(0.8);

    // separator
    doc.rect(MARGIN, doc.y, CONTENT_W, 1).fillColor("#2a2a3e").fill();
    doc.moveDown(0.6);

    for (let ri = 0; ri < rdos.length; ri++) {
      const rdo = rdos[ri];

      if (ri > 0) {
        // page break between RDOs
        doc.addPage();
        doc.rect(0, 0, PAGE_W, 841.89).fillColor("#0f0f17").fill();
      }

      // RDO title bar
      const statusLabel = STATUS_LABEL[rdo.status] ?? rdo.status;
      doc
        .rect(MARGIN, doc.y, CONTENT_W, 22)
        .fillColor("#16162a")
        .fill();
      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .fillColor("#c0c0e0")
        .text(
          `RDO · ${fmtDate(rdo.data)}${rdo.docNumero ? `  ·  ${rdo.docNumero}` : ""}`,
          MARGIN + 8,
          doc.y - 18,
          { width: CONTENT_W * 0.7 },
        );
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .fillColor(rdo.status === "APROVADO" ? "#4ade80" : rdo.status === "REPROVADO" ? "#f87171" : "#93c5fd")
        .text(statusLabel, MARGIN + CONTENT_W * 0.7, doc.y - 12, {
          width: CONTENT_W * 0.3 - 8,
          align: "right",
        });
      doc.y += 6;

      // Dados do empreendimento
      sectionTitle(doc, "Dados do Empreendimento");
      kv(doc, [
        ["Contrato Nº", rdo.contratoNumero ?? ""],
        ["Doc. Nº", rdo.docNumero ?? ""],
        ["Data", fmtDate(rdo.data)],
        ["Turnos", rdo.turnos ?? ""],
        ["Jornada de Trabalho", rdo.jornadaTrabalho ?? ""],
        ["Localidade", rdo.localidade ?? ""],
        ["Obra", rdo.obra?.name ?? ""],
        ["Data de Início", fmtDate(rdo.dataInicio)],
        ["Data de Término", fmtDate(rdo.dataTermino)],
        ["Dias Decorridos", rdo.diasDecorridos != null ? String(rdo.diasDecorridos) : ""],
        ["Dias Restantes", rdo.diasRestantes != null ? String(rdo.diasRestantes) : ""],
        ["Dias de Atraso", rdo.diasAtraso != null ? String(rdo.diasAtraso) : ""],
      ], 3);

      // Condições climáticas
      sectionTitle(doc, "Condições Climáticas");
      kv(doc, [
        ["Manhã", CLIMA_LABEL[rdo.climaManha ?? ""] ?? rdo.climaManha ?? ""],
        ["Tarde", CLIMA_LABEL[rdo.climaTarde ?? ""] ?? rdo.climaTarde ?? ""],
        ["Noite", CLIMA_LABEL[rdo.climaNoite ?? ""] ?? rdo.climaNoite ?? ""],
        ["Chuva (mm)", rdo.chuvaQuantMm != null ? `${rdo.chuvaQuantMm} mm` : ""],
      ], 4);

      // Efetivo indireta
      const efIndir = row(rdo.efetivoIndireta);
      if (efIndir.length > 0) {
        sectionTitle(doc, "Efetivo MO Indireta");
        const c1 = CONTENT_W * 0.75;
        const c2 = CONTENT_W * 0.25;
        tableHeader(doc, [{ label: "Empresa", width: c1 }, { label: "Efetivo", width: c2 }]);
        efIndir.forEach((r, i) => {
          tableRow(doc, [
            { value: String(r["empresa"] ?? ""), width: c1 },
            { value: String(r["efetivo"] ?? ""), width: c2 },
          ], i % 2 === 0);
        });
        const total = efIndir.reduce((s, r) => s + (Number(r["efetivo"]) || 0), 0);
        kv(doc, [["Total MO Indireta", String(total)]], 1);
      }

      // Efetivo direta
      const efDireta = row(rdo.efetivoODireta);
      if (efDireta.length > 0) {
        sectionTitle(doc, "Efetivo MO Direta");
        const c1 = CONTENT_W * 0.75;
        const c2 = CONTENT_W * 0.25;
        tableHeader(doc, [{ label: "Empresa", width: c1 }, { label: "Efetivo", width: c2 }]);
        efDireta.forEach((r, i) => {
          tableRow(doc, [
            { value: String(r["empresa"] ?? ""), width: c1 },
            { value: String(r["efetivo"] ?? ""), width: c2 },
          ], i % 2 === 0);
        });
        const total = efDireta.reduce((s, r) => s + (Number(r["efetivo"]) || 0), 0);
        kv(doc, [["Total MO Direta", String(total)]], 1);
      }

      // Equipamentos
      const equips = row(rdo.equipamentos);
      if (equips.length > 0) {
        sectionTitle(doc, "Equipamentos");
        const c1 = CONTENT_W * 0.8;
        const c2 = CONTENT_W * 0.2;
        tableHeader(doc, [{ label: "Equipamento", width: c1 }, { label: "Qtd", width: c2 }]);
        equips.forEach((r, i) => {
          tableRow(doc, [
            { value: String(r["equipamento"] ?? ""), width: c1 },
            { value: String(r["quantidade"] ?? ""), width: c2 },
          ], i % 2 === 0);
        });
      }

      // Atividades
      const ativs = row(rdo.atividades);
      if (ativs.length > 0) {
        sectionTitle(doc, "Atividades Executadas");
        const c1 = CONTENT_W * 0.75;
        const c2 = CONTENT_W * 0.25;
        tableHeader(doc, [{ label: "Atividade", width: c1 }, { label: "Status", width: c2 }]);
        ativs.forEach((r, i) => {
          tableRow(doc, [
            { value: String(r["atividadeExecutada"] ?? ""), width: c1 },
            { value: ATIV_LABEL[String(r["status"] ?? "")] ?? String(r["status"] ?? ""), width: c2 },
          ], i % 2 === 0);
        });
      }

      // Materiais
      const mats = row(rdo.materiais);
      if (mats.length > 0) {
        sectionTitle(doc, "Recebimento de Materiais");
        const c1 = CONTENT_W * 0.35;
        const c2 = CONTENT_W * 0.45;
        const c3 = CONTENT_W * 0.2;
        tableHeader(doc, [
          { label: "Fornecedor", width: c1 },
          { label: "Material", width: c2 },
          { label: "NF Recebidas", width: c3 },
        ]);
        mats.forEach((r, i) => {
          tableRow(doc, [
            { value: String(r["fornecedor"] ?? ""), width: c1 },
            { value: String(r["material"] ?? ""), width: c2 },
            { value: String(r["nfRecebidas"] ?? ""), width: c3 },
          ], i % 2 === 0);
        });
      }

      // Considerações
      if (rdo.consideracoesContratada || rdo.consideracoesFiscalizacao) {
        sectionTitle(doc, "Considerações Complementares");
        if (rdo.consideracoesContratada) {
          kv(doc, [["Contratada", rdo.consideracoesContratada]], 1);
        }
        if (rdo.consideracoesFiscalizacao) {
          kv(doc, [["Fiscalização", rdo.consideracoesFiscalizacao]], 1);
        }
      }

      // Aprovação
      if (rdo.approvedBy && rdo.approvedAt) {
        sectionTitle(doc, "Aprovação");
        kv(doc, [
          ["Aprovado por", rdo.approvedBy.name],
          ["Data de Aprovação", fmtDateTime(rdo.approvedAt)],
        ], 2);
      }
      if (rdo.status === "REPROVADO" && rdo.rejectionReason) {
        sectionTitle(doc, "Reprovação");
        kv(doc, [["Motivo", rdo.rejectionReason]], 1);
      }

      // Criado por
      doc.moveDown(0.4);
      doc
        .fontSize(7.5)
        .font("Helvetica")
        .fillColor("#505060")
        .text(
          `Criado por: ${rdo.createdBy?.name ?? "—"}  ·  Status: ${statusLabel}`,
          MARGIN,
          doc.y,
          { width: CONTENT_W },
        );
    }

    // page numbers
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(7)
        .font("Helvetica")
        .fillColor("#404050")
        .text(`Página ${i + 1} de ${totalPages}`, MARGIN, 841.89 - 30, {
          width: CONTENT_W,
          align: "right",
        });
    }

    doc.end();
  });
}
