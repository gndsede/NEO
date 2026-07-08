import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import sharp from "sharp";
import { prisma } from "../../lib/prisma.js";
import { signLocalFileUrl } from "../../lib/file-signing.js";
import { workerScopeWhere, type AuthScope } from "../../lib/scope.js";
import { badgeService } from "../badge/badge.service.js";

// Badge: 57×89 mm → pontos PDF (1 pt = 1/72 pol)
const MM_TO_PT = 72 / 25.4;
const PT_W = 57 * MM_TO_PT; // ~161.575
const PT_H = 89 * MM_TO_PT; // ~252.283

// Template COI BACKUP: 655×1024 px → escala pt/px
const CANVAS_W = 655;
const CANVAS_H = 1024;
const K = PT_W / CANVAS_W;

// ── Composição no template (px) ───────────────────────────────────────────
// Layout COI BACKUP: caixa azul arredondada à esquerda (QR + faixa do CPF),
// área branca à direita (FOTO), faixa branca abaixo (Nome/Cargo), rodapé azul
// (Matrícula).
//
// QR — dentro da caixa azul à esquerda.
const QR_LEFT = 24;
const QR_TOP  = 360;
const QR_PX   = 225;

// Foto — área branca à direita da caixa azul.
const FOTO_LEFT = 360;
const FOTO_TOP  = 335;
const FOTO_W    = 262;
const FOTO_H    = 330;

// ── Texto (px → pt via K) ─────────────────────────────────────────────────
// CPF — faixa inferior da caixa azul (texto branco), abaixo do QR.
const CPF_X  = 22 * K;
const CPF_Y  = 632 * K;
const CPF_FS = 21 * K;

// Nome / Cargo — faixa branca entre a caixa azul e a linha horizontal.
const NOME_Y  = 745 * K;
const NOME_FS = 26 * K;

const CARGO_Y  = 781 * K;
const CARGO_FS = 21 * K;

// Matrícula — centralizada na faixa azul inferior (texto branco).
const MAT_Y  = 905 * K;
const MAT_FS = 24 * K;

const COR_AZUL   = "#002D57";
const COR_BRANCO = "#FFFFFF";
const COR_CINZA  = "#555555";

/** Formata CPF (somente dígitos) como XXX.XXX.XXX-XX. */
function formatarCpf(cpf: string): string {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return cpf ?? "";
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

const FONT_DIR = path.join(process.cwd(), "assets", "fonts");
const FONT_R = path.join(FONT_DIR, "calibri.ttf");
const FONT_B = path.join(FONT_DIR, "calibrib.ttf");

// ─── helpers internos ────────────────────────────────────────────────────────

async function gerarQrBuffer(valor: string): Promise<Buffer> {
  const conteudo = (valor ?? "").trim() || "SEM-DADOS";
  return QRCode.toBuffer(conteudo, {
    type: "png",
    margin: 2,
    width: QR_PX,
    color: { dark: "#000000", light: "#FFFFFF" },
  }) as Promise<Buffer>;
}

async function baixarFoto(url: string): Promise<Buffer | undefined> {
  try {
    // URLs do storage local agora exigem assinatura — assina antes de baixar.
    const res = await fetch(signLocalFileUrl(url));
    if (!res.ok) return undefined;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * Recorta a foto no tamanho do box (cover) e arredonda os 4 cantos para um
 * visual de cartão (mantém transparência nos cantos).
 */
async function prepararFoto(fotoBuf: Buffer): Promise<Buffer> {
  const r = 22;
  const mask = Buffer.from(
    `<svg width="${FOTO_W}" height="${FOTO_H}">` +
      `<rect x="0" y="0" width="${FOTO_W}" height="${FOTO_H}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  return sharp(fotoBuf)
    .resize(FOTO_W, FOTO_H, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function compositar(
  templateBuf: Buffer,
  qrBuf: Buffer,
  fotoBuf?: Buffer,
): Promise<Buffer> {
  // Normaliza o template para o canvas de referência (sRGB, fundo branco) —
  // garante que as posições batem e preserva as cores (sem JPEG/CMYK).
  const tpl = await sharp(templateBuf)
    .resize(CANVAS_W, CANVAS_H, { fit: "fill" })
    .flatten({ background: "#FFFFFF" })
    .toColourspace("srgb")
    .png()
    .toBuffer();

  const composites: sharp.OverlayOptions[] = [];

  if (fotoBuf) {
    composites.push({
      input: await prepararFoto(fotoBuf),
      left: FOTO_LEFT,
      top: FOTO_TOP,
    });
  }

  // QR por último, garantindo o quiet zone branco (visível sobre qualquer fundo).
  composites.push({
    input: await sharp(qrBuf)
      .resize(QR_PX, QR_PX)
      .flatten({ background: "#FFFFFF" })
      .png()
      .toBuffer(),
    left: QR_LEFT,
    top: QR_TOP,
  });

  // Saída em PNG (sem perda, sem ambiguidade de espaço de cor no pdfkit).
  return sharp(tpl)
    .composite(composites)
    .flatten({ background: "#FFFFFF" })
    .png()
    .toBuffer();
}

function criarDoc() {
  return new (PDFDocument as unknown as new (o: object) => InstanceType<typeof PDFDocument>)({
    size: [PT_W, PT_H],
    margin: 0,
    autoFirstPage: false,
  });
}

function pdfParaBuffer(doc: InstanceType<typeof PDFDocument>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

interface DadosCracha {
  nome: string;
  funcao: string;
  matricula: string;
  cpf: string;
}

/**
 * Reduz a fonte até o texto caber em `larguraMaxPt` (evita estourar/transbordar
 * em nomes/cargos longos). Retorna o tamanho de fonte final em pt.
 */
function ajustarFonte(
  doc: InstanceType<typeof PDFDocument>,
  texto: string,
  font: string,
  fsInicial: number,
  larguraMaxPt: number,
): number {
  const d = doc as unknown as {
    font(f: string): unknown;
    fontSize(s: number): unknown;
    widthOfString(t: string): number;
  };
  d.font(font);
  let fs = fsInicial;
  d.fontSize(fs);
  while (fs > 5 && d.widthOfString(texto) > larguraMaxPt) {
    fs -= 0.5;
    d.fontSize(fs);
  }
  return fs;
}

function adicionarPagina(
  doc: InstanceType<typeof PDFDocument>,
  imgBuf: Buffer,
  dados: DadosCracha,
): void {
  doc.addPage();

  (doc as unknown as { image(b: Buffer, x: number, y: number, o: object): void })
    .image(imgBuf, 0, 0, { width: PT_W });

  // CPF — texto branco na faixa inferior da caixa azul (abaixo da foto)
  const cpfTxt = `CPF: ${formatarCpf(dados.cpf)}`;
  const cpfFs = ajustarFonte(doc, cpfTxt, FONT_R, CPF_FS, (FOTO_W - 24) * K);
  doc
    .fillColor(COR_BRANCO)
    .font(FONT_R)
    .fontSize(cpfFs)
    .text(cpfTxt, CPF_X, CPF_Y, { lineBreak: false });

  // Nome — centralizado na faixa branca (auto-ajuste para nomes longos)
  const nomeTxt = dados.nome.toUpperCase();
  const nomeFs = ajustarFonte(doc, nomeTxt, FONT_B, NOME_FS, PT_W * 0.92);
  doc
    .fillColor(COR_AZUL)
    .font(FONT_B)
    .fontSize(nomeFs)
    .text(nomeTxt, 0, NOME_Y, { width: PT_W, align: "center", lineBreak: false });

  // Cargo — centralizado abaixo do nome
  const cargoTxt = dados.funcao.toUpperCase();
  const cargoFs = ajustarFonte(doc, cargoTxt, FONT_R, CARGO_FS, PT_W * 0.92);
  doc
    .fillColor(COR_CINZA)
    .font(FONT_R)
    .fontSize(cargoFs)
    .text(cargoTxt, 0, CARGO_Y, { width: PT_W, align: "center", lineBreak: false });

  // Matrícula — centralizada na faixa azul inferior (texto branco)
  const matFs = ajustarFonte(doc, dados.matricula, FONT_B, MAT_FS, PT_W * 0.7);
  doc
    .fillColor(COR_BRANCO)
    .font(FONT_B)
    .fontSize(matFs)
    .text(dados.matricula, 0, MAT_Y, { width: PT_W, align: "center", lineBreak: false });
}

// ─── exports ─────────────────────────────────────────────────────────────────

/** Gera PDF de um único colaborador usando os dados do banco. */
export async function gerarPorWorker(
  templateBuf: Buffer,
  workerId: string,
  scope: AuthScope,
): Promise<Buffer> {
  const payload = await badgeService.generate(scope, workerId);

  const fotoBuf = payload.worker.photoUrl
    ? await baixarFoto(payload.worker.photoUrl)
    : undefined;

  const qrBuf = await gerarQrBuffer(payload.access.qrContent);
  const imgBuf = await compositar(templateBuf, qrBuf, fotoBuf);

  const doc = criarDoc();
  const done = pdfParaBuffer(doc);
  adicionarPagina(doc, imgBuf, {
    nome: payload.worker.fullName,
    funcao: payload.worker.functionName ?? payload.worker.role,
    matricula: payload.worker.registration ?? "—",
    cpf: payload.worker.cpf,
  });
  doc.end();

  return done;
}

/** Gera PDF em lote para todos (ou os selecionados) colaboradores ativos do escopo. */
export async function gerarLote(
  templateBuf: Buffer,
  scope: AuthScope,
  workerIds?: string[],
): Promise<Buffer> {
  const ids =
    workerIds && workerIds.length > 0
      ? workerIds
      : (
          await prisma.worker.findMany({
            where: { ...workerScopeWhere(scope), status: "ACTIVE" },
            select: { id: true },
            orderBy: { fullName: "asc" },
          })
        ).map((w) => w.id);

  if (ids.length === 0) throw new Error("Nenhum colaborador ativo encontrado");

  const doc = criarDoc();
  const done = pdfParaBuffer(doc);

  for (const id of ids) {
    try {
      const payload = await badgeService.generate(scope, id);
      const fotoBuf = payload.worker.photoUrl
        ? await baixarFoto(payload.worker.photoUrl)
        : undefined;
      const qrBuf = await gerarQrBuffer(payload.access.qrContent);
      const imgBuf = await compositar(templateBuf, qrBuf, fotoBuf);
      adicionarPagina(doc, imgBuf, {
        nome: payload.worker.fullName,
        funcao: payload.worker.functionName ?? payload.worker.role,
        matricula: payload.worker.registration ?? "—",
        cpf: payload.worker.cpf,
      });
    } catch {
      // colaborador sem dados suficientes: pula sem travar o lote
    }
  }

  doc.end();
  return done;
}
