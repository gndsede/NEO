import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Token de acesso do colaborador (conteúdo do QR Code).
 *
 * Token base (persistido em `Worker.qrHash`):
 *   NEO-0A0AA0 — prefixo fixo + 6 caracteres onde 0 = dígito (0-9) e
 *   A = letra maiúscula (A-Z). Exemplo: NEO-3K7BM2
 *
 * Payload assinado (impresso no QR do crachá):
 *   NEO-0A0AA0-XXXXXXXX — token base + 8 hex maiúsculos de
 *   HMAC-SHA256(BADGE_HASH_SECRET, token base).
 *
 * Segurança (auditoria F02 — CWE-338/CWE-798, OWASP A02:2021):
 *  - geração com CSPRNG (`crypto.randomInt`), não `Math.random()`;
 *  - assinatura HMAC vincula o QR ao segredo do servidor: um token forjado
 *    ou adivinhado não passa na verificação de assinatura;
 *  - comparação de assinatura em tempo constante (`timingSafeEqual`);
 *  - tokens legados (sem assinatura) continuam aceitos durante a migração;
 *    para exigir assinatura, rejeite o formato base nos pontos de scan após
 *    reimprimir os crachás (ver `resolveScannedToken`).
 */

export const NEO_QR_SPEC = {
  prefix: "NEO-",
  pattern: "NEO-0A0AA0",
  signedPattern: "NEO-0A0AA0-XXXXXXXX",
  description:
    "0 = dígito (0-9), A = letra maiúscula (A-Z); X = hex da assinatura HMAC (crachás novos)",
  regex: "^NEO-\\d[A-Z]\\d[A-Z]{2}\\d$",
  signedRegex: "^NEO-\\d[A-Z]\\d[A-Z]{2}\\d-[0-9A-F]{8}$",
  example: "NEO-3K7BM2",
  slots: ["digit", "letter", "digit", "letter", "letter", "digit"] as const,
} as const;

const NEO_TOKEN_REGEX = /^NEO-\d[A-Z]\d[A-Z]{2}\d$/;
const NEO_SIGNED_TOKEN_REGEX = /^(NEO-\d[A-Z]\d[A-Z]{2}\d)-([0-9A-F]{8})$/;

const SIGNATURE_HEX_CHARS = 8;

function randomDigit(): string {
  return randomInt(0, 10).toString();
}

function randomLetter(): string {
  return String.fromCharCode(65 + randomInt(0, 26));
}

/** Gera um token no padrão NEO-0A0AA0 usando CSPRNG. */
export function generateNeoAccessToken(): string {
  return `NEO-${randomDigit()}${randomLetter()}${randomDigit()}${randomLetter()}${randomLetter()}${randomDigit()}`;
}

/** Alias usado na criação do colaborador (campo `qrHash` no banco). */
export function generateWorkerQrHash(): string {
  return generateNeoAccessToken();
}

export function isValidNeoAccessToken(token: string): boolean {
  return NEO_TOKEN_REGEX.test(token.trim().toUpperCase());
}

/** Assinatura HMAC-SHA256 truncada (8 hex maiúsculos) do token base. */
export function signAccessToken(baseToken: string): string {
  return createHmac("sha256", env.BADGE_HASH_SECRET)
    .update(baseToken)
    .digest("hex")
    .slice(0, SIGNATURE_HEX_CHARS)
    .toUpperCase();
}

/** Payload completo para impressão no QR do crachá: token + assinatura. */
export function buildSignedQrPayload(baseToken: string): string {
  return `${baseToken}-${signAccessToken(baseToken)}`;
}

/** Verificação em tempo constante da assinatura de um token. */
export function verifyAccessTokenSignature(
  baseToken: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signAccessToken(baseToken), "utf8");
  const provided = Buffer.from(signature.toUpperCase(), "utf8");
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

/** Normaliza leitura bruta do QR (texto puro ou URL com ?t=). */
export function normalizeScannedQr(raw: string): string {
  let value = raw.trim();
  try {
    const url = new URL(value);
    value = url.searchParams.get("t") ?? value;
  } catch {
    /* valor bruto */
  }
  return value.trim().toUpperCase();
}

export interface ResolvedScan {
  /** Token base (formato NEO-0A0AA0) pronto para lookup, ou null se inválido. */
  token: string | null;
  /** true quando o payload trazia assinatura HMAC válida. */
  signed: boolean;
  /** Motivo da rejeição, quando token === null. */
  error?: string;
}

/**
 * Resolve uma leitura de QR para o token base verificado.
 *  - Payload assinado: valida o HMAC; assinatura errada = rejeição imediata.
 *  - Token legado (sem assinatura): aceito durante a migração — a validade
 *    real continua garantida pelo lookup no banco (`qrHash` único).
 */
export function resolveScannedToken(raw: string): ResolvedScan {
  const value = normalizeScannedQr(raw);

  const signedMatch = NEO_SIGNED_TOKEN_REGEX.exec(value);
  if (signedMatch) {
    const [, base, sig] = signedMatch;
    if (!verifyAccessTokenSignature(base, sig)) {
      return { token: null, signed: false, error: "Assinatura do crachá inválida" };
    }
    return { token: base, signed: true };
  }

  if (NEO_TOKEN_REGEX.test(value)) {
    return { token: value, signed: false };
  }

  return {
    token: null,
    signed: false,
    error: "QR inválido — formato esperado: NEO-0A0AA0",
  };
}
