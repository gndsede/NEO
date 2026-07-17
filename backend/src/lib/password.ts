import bcrypt from "bcryptjs";

/**
 * Hash de senha centralizado (auditoria F17 — OWASP ASVS V2.4).
 *
 * Custo bcrypt 12 (mínimo recomendado atual). Hashes antigos (custo 10)
 * continuam verificáveis; use `needsRehash` + `hashPassword` no login
 * bem-sucedido para re-hash oportunista sem forçar troca de senha.
 */
export const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** true quando o hash foi gerado com custo abaixo do atual. */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    // Hash em formato inesperado: força re-hash na próxima oportunidade.
    return true;
  }
}
