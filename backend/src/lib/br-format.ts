/**
 * Formatação de CPF/CNPJ para saídas legíveis (PDF, planilha, crachá).
 * O banco guarda só dígitos; valor fora do tamanho esperado sai como veio.
 */

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

export function formatCpf(v: string | null | undefined): string {
  const d = digits(v);
  if (d.length !== 11) return v ?? "";
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

/** Fornecedor pode ser pessoa física: 11 dígitos sai como CPF. */
export function formatCpfCnpj(v: string | null | undefined): string {
  const d = digits(v);
  if (d.length === 11) return formatCpf(d);
  if (d.length !== 14) return v ?? "";
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}
