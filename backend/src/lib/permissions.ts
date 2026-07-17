/**
 * Permissões por ação (o que o usuário pode fazer), não por aba view/edit/delete.
 */
export const PERMISSION_CATALOG = [
  { group: "Painel", key: "dashboard.view", label: "Visualizar visão geral" },
  { group: "Obras", key: "obras.view", label: "Visualizar obras" },
  { group: "Obras", key: "obras.manage", label: "Cadastrar e editar obras" },
  { group: "Registros", key: "registros.view", label: "Visualizar cadastro de registros" },
  { group: "Registros", key: "registros.manage", label: "Cadastrar e editar registros" },
  { group: "Funções e tipos", key: "tipos.view", label: "Visualizar funções e tipos" },
  { group: "Funções e tipos", key: "tipos.manage", label: "Cadastrar e editar funções e tipos" },
  { group: "Documentos", key: "documentos.view", label: "Visualizar documentação" },
  { group: "Documentos", key: "documentos.attach", label: "Anexar documentos" },
  { group: "Documentos", key: "documentos.approve", label: "Aprovar e reprovar documentos" },
  { group: "Documentos", key: "documentos.mark_na", label: "Marcar registro como N/A" },
  { group: "Colaboradores", key: "colaboradores.view", label: "Visualizar colaboradores" },
  { group: "Colaboradores", key: "colaboradores.manage", label: "Cadastrar e editar colaboradores" },
  { group: "Fornecedores", key: "fornecedores.view", label: "Visualizar fornecedores" },
  { group: "Fornecedores", key: "fornecedores.manage", label: "Cadastrar e editar fornecedores" },
  { group: "Crachá", key: "cracha.view", label: "Acessar geração de crachá" },
  { group: "Crachá", key: "cracha.generate", label: "Gerar crachás" },
  { group: "Catraca", key: "catraca.view", label: "Visualizar registros de acesso" },
  { group: "Catraca", key: "catraca.manage", label: "Registrar acessos manualmente" },
  { group: "Usuários", key: "usuarios.view", label: "Visualizar usuários" },
  { group: "Usuários", key: "usuarios.manage", label: "Cadastrar e editar usuários" },
  { group: "RDO", key: "rdo.view", label: "Visualizar RDOs" },
  { group: "RDO", key: "rdo.manage", label: "Criar e editar RDOs" },
  { group: "RDO", key: "rdo.approve", label: "Aprovar e reprovar RDOs" },
  // Exports revelam CPF/RG completos (decriptados) — permissão dedicada,
  // concedida apenas a perfis administrativos (LGPD Art. 6º, III/VII; OWASP API5:2023).
  { group: "Relatórios", key: "relatorios.export_pii", label: "Exportar relatórios com CPF/RG" },
] as const;

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

export const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.map((p) => p.key);

export type UserProfile = "USER" | "COLLABORATOR";

/** Lista de chaves de permissão concedidas ao usuário. */
export type PermissionList = PermissionKey[];

const LEGACY_MODULE_MAP: Record<
  string,
  { view?: PermissionKey; edit?: PermissionKey; delete?: PermissionKey }
> = {
  dashboard: { view: "dashboard.view" },
  obras: { view: "obras.view", edit: "obras.manage", delete: "obras.manage" },
  registros: { view: "registros.view", edit: "registros.manage", delete: "registros.manage" },
  tipos: { view: "tipos.view", edit: "tipos.manage", delete: "tipos.manage" },
  documentos: {
    view: "documentos.view",
    edit: "documentos.attach",
    delete: "documentos.approve",
  },
  colaboradores: {
    view: "colaboradores.view",
    edit: "colaboradores.manage",
    delete: "colaboradores.manage",
  },
  fornecedores: {
    view: "fornecedores.view",
    edit: "fornecedores.manage",
    delete: "fornecedores.manage",
  },
  cracha: { view: "cracha.view", edit: "cracha.generate", delete: "cracha.generate" },
  catraca: { view: "catraca.view", edit: "catraca.manage", delete: "catraca.manage" },
  usuarios: { view: "usuarios.view", edit: "usuarios.manage", delete: "usuarios.manage" },
  rdo: { view: "rdo.view", edit: "rdo.manage", delete: "rdo.approve" },
};

function fromLegacyMap(input: Record<string, { view?: boolean; edit?: boolean; delete?: boolean }>): PermissionList {
  const set = new Set<PermissionKey>();
  for (const [mod, perms] of Object.entries(input)) {
    const map = LEGACY_MODULE_MAP[mod];
    if (!map) continue;
    if (perms.view && map.view) set.add(map.view);
    if (perms.edit && map.edit) set.add(map.edit);
    if (perms.delete && map.delete) set.add(map.delete);
    if (mod === "documentos" && (perms.edit || perms.delete)) {
      if (perms.delete) set.add("documentos.approve");
    }
  }
  return [...set];
}

export function fullPermissions(): PermissionList {
  return [...ALL_PERMISSION_KEYS];
}

/** Normaliza permissões antigas (objeto por módulo) ou lista de chaves. */
export function normalizePermissions(input: unknown): PermissionList {
  if (Array.isArray(input)) {
    return input.filter((k): k is PermissionKey =>
      ALL_PERMISSION_KEYS.includes(k as PermissionKey),
    );
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, { view?: boolean; edit?: boolean; delete?: boolean }>;
    const firstKey = Object.keys(obj)[0];
    if (firstKey && obj[firstKey] && typeof obj[firstKey] === "object" && "view" in (obj[firstKey] as object)) {
      return fromLegacyMap(obj);
    }
  }
  return [];
}

export function hasCapability(
  user: { permissions?: PermissionList | null },
  key: PermissionKey,
): boolean {
  const perms = normalizePermissions(user.permissions);
  return perms.includes(key);
}

export function hasAnyCapability(
  user: { permissions?: PermissionList | null },
  keys: PermissionKey[],
): boolean {
  return keys.some((k) => hasCapability(user, k));
}

/** Sidebar: qualquer permissão do grupo habilita o menu. */
export function hasGroupAccess(
  user: { permissions?: PermissionList | null },
  groupPrefix: string,
): boolean {
  const perms = normalizePermissions(user.permissions);
  return perms.some((k) => k.startsWith(`${groupPrefix}.`));
}

export const SIDEBAR_PERMISSION_MAP: Record<string, PermissionKey[]> = {
  dashboard: ["dashboard.view"],
  obras: ["obras.view", "obras.manage"],
  registros: ["registros.view", "registros.manage"],
  tipos: ["tipos.view", "tipos.manage"],
  documentos: [
    "documentos.view",
    "documentos.attach",
    "documentos.approve",
    "documentos.mark_na",
  ],
  colaboradores: ["colaboradores.view", "colaboradores.manage"],
  fornecedores: ["fornecedores.view", "fornecedores.manage"],
  cracha: ["cracha.view", "cracha.generate"],
  catraca: ["catraca.view", "catraca.manage"],
  usuarios: ["usuarios.view", "usuarios.manage"],
  rdo: ["rdo.view", "rdo.manage", "rdo.approve"],
};
