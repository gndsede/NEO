import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * Códigos de backup do 2FA (auditoria F13 — OWASP ASVS V2.8).
 *
 * 10 códigos de uso único no formato XXXX-XXXX (alfabeto sem caracteres
 * ambíguos). Apenas os hashes bcrypt são persistidos (`User.totpBackupCodes`);
 * o texto puro é exibido uma única vez, na geração. Cada uso remove o hash
 * consumido — um código não pode ser reutilizado.
 */

const CODE_COUNT = 10;
// Sem 0/O/1/I/L para reduzir erro de digitação.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUP = 4;

export const BACKUP_CODE_REGEX = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

function randomGroup(): string {
  let out = "";
  for (let i = 0; i < GROUP; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

export function normalizeBackupCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function looksLikeBackupCode(raw: string): boolean {
  return BACKUP_CODE_REGEX.test(normalizeBackupCode(raw));
}

export interface GeneratedBackupCodes {
  /** Códigos em texto puro — mostrar UMA vez ao usuário e descartar. */
  plainCodes: string[];
  /** Hashes bcrypt para persistir em User.totpBackupCodes. */
  hashes: string[];
}

export async function generateBackupCodes(): Promise<GeneratedBackupCodes> {
  const plainCodes = Array.from(
    { length: CODE_COUNT },
    () => `${randomGroup()}-${randomGroup()}`,
  );
  // Custo menor que senha (10): códigos têm ~40 bits de entropia aleatória,
  // muito acima de senhas humanas, e a verificação percorre a lista inteira.
  const hashes = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 10)));
  return { plainCodes, hashes };
}

/**
 * Verifica um código contra a lista de hashes e o consome.
 * Retorna a lista remanescente quando válido, ou null quando inválido.
 */
export async function consumeBackupCode(
  raw: string,
  storedHashes: unknown,
): Promise<string[] | null> {
  if (!Array.isArray(storedHashes) || storedHashes.length === 0) return null;
  const code = normalizeBackupCode(raw);
  if (!BACKUP_CODE_REGEX.test(code)) return null;

  for (let i = 0; i < storedHashes.length; i++) {
    const hash = storedHashes[i];
    if (typeof hash !== "string") continue;
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(code, hash)) {
      return [
        ...storedHashes.slice(0, i),
        ...storedHashes.slice(i + 1),
      ] as string[];
    }
  }
  return null;
}
