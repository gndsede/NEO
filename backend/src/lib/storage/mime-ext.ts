/**
 * Extensão de arquivo derivada do MIME type já validado pelo fileFilter do
 * multer — nunca do nome original enviado pelo cliente. O nome original é
 * livre (o navegador manda o que o usuário escolher) e, se usado para montar
 * a extensão persistida, permite salvar um arquivo com Content-Type
 * permitido (ex.: "image/jpeg") mas extensão ".html"/".svg" — quando servido
 * estaticamente (driver local), a extensão manda no Content-Type de
 * resposta, abrindo brecha de stored XSS.
 */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

export function safeExtFromMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? "";
}
