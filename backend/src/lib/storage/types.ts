/**
 * Contrato comum de storage. Qualquer driver (local, S3, Supabase) implementa
 * esta interface, de modo que a aplicação nunca depende do provedor concreto.
 */
export interface StoredFile {
  /** Chave/objeto no provedor (ex.: "workers/abc/photo.jpg"). */
  key: string;
  /** URL acessível para leitura (pública ou base do provedor). */
  url: string;
  mimeType?: string;
  size?: number;
}

export interface UploadInput {
  /** Conteúdo do arquivo. */
  buffer: Buffer;
  /** Nome original (usado para extensão). */
  originalName: string;
  mimeType: string;
  /** Prefixo/pasta lógica (ex.: "workers/<id>/documents"). */
  folder: string;
}

export interface StorageDriver {
  readonly name: string;
  upload(input: UploadInput): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  /**
   * Gera URL temporária assinada (quando suportado).
   * Drivers sem suporte devem retornar a URL pública.
   */
  getSignedUrl?(key: string, expiresInSeconds?: number): Promise<string>;
  /**
   * Lê o conteúdo de volta pela chave. Usado por quem precisa dos bytes no
   * próprio processo (ex.: compor a foto no crachá) sem depender de um
   * round-trip HTTP na URL pública — que falha quando o host/porta gravado
   * no upload não é alcançável a partir do próprio servidor.
   */
  download(key: string): Promise<Buffer>;
  /**
   * Extrai a chave a partir de uma URL gerada por este driver.
   * Retorna `null` quando a URL não pertence a ele.
   */
  keyFromUrl(url: string): string | null;
}
