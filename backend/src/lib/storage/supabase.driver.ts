import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import { safeExtFromMime } from "./mime-ext.js";
import type { StorageDriver, StoredFile, UploadInput } from "./types.js";

/**
 * Driver Supabase Storage. Usa a service role key (server-side only).
 */
export class SupabaseStorageDriver implements StorageDriver {
  readonly name = "supabase";
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor() {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.SUPABASE_BUCKET
    ) {
      throw new Error(
        "Driver Supabase requer SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e SUPABASE_BUCKET",
      );
    }
    this.bucket = env.SUPABASE_BUCKET;
    this.client = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    const ext = safeExtFromMime(input.mimeType);
    const key = `${input.folder.replace(/\/$/, "")}/${randomUUID()}${ext}`;

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(key, input.buffer, {
        contentType: input.mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`Falha no upload Supabase: ${error.message}`);
    }

    const { data } = this.client.storage.from(this.bucket).getPublicUrl(key);

    return {
      key,
      url: data.publicUrl,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .remove([key]);
    if (error) {
      throw new Error(`Falha ao remover do Supabase: ${error.message}`);
    }
  }

  async download(key: string): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(key);
    if (error || !data) {
      throw new Error(
        `Falha ao baixar do Supabase: ${error?.message ?? "sem conteúdo"}`,
      );
    }
    return Buffer.from(await data.arrayBuffer());
  }

  keyFromUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // URL pública: /storage/v1/object/public/<bucket>/<key>
    // URL assinada: /storage/v1/object/sign/<bucket>/<key>?token=...
    const m = parsed.pathname.match(
      /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/,
    );
    if (!m || m[1] !== this.bucket) return null;
    return decodeURIComponent(m[2]);
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) {
      throw new Error(
        `Falha ao gerar URL assinada no Supabase: ${error?.message}`,
      );
    }
    return data.signedUrl;
  }
}
