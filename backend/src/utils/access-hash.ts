/**
 * Token de acesso do colaborador (conteúdo do QR Code).
 *
 * Formato: NEO-0A0AA0 — prefixo fixo + 6 caracteres onde
 * 0 = dígito (0-9) e A = letra maiúscula (A-Z).
 * Exemplo: NEO-3K7BM2
 */

export const NEO_QR_SPEC = {
  prefix: "NEO-",
  pattern: "NEO-0A0AA0",
  description: "0 = dígito (0-9), A = letra maiúscula (A-Z)",
  regex: "^NEO-\\d[A-Z]\\d[A-Z]{2}\\d$",
  example: "NEO-3K7BM2",
  slots: ["digit", "letter", "digit", "letter", "letter", "digit"] as const,
} as const;

const NEO_TOKEN_REGEX = /^NEO-\d[A-Z]\d[A-Z]{2}\d$/;

function randomDigit(): string {
  return Math.floor(Math.random() * 10).toString();
}

function randomLetter(): string {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

/** Gera um token no padrão NEO-0A0AA0 (aleatório). */
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
