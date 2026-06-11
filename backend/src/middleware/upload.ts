import multer from "multer";
import { BadRequest } from "../lib/errors.js";

/**
 * Configuração do multer para multipart/form-data, mantendo os arquivos em
 * memória (Buffer) para repasse direto ao driver de storage.
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(
        BadRequest(
          `Tipo de arquivo não permitido: ${file.mimetype}. Aceitos: JPEG, PNG, WEBP, PDF.`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

/**
 * Campos esperados no cadastro de Worker:
 * - photo: foto do colaborador (1)
 * - documents: documentos diversos (vários)
 */
export const workerUpload = upload.fields([
  { name: "photo", maxCount: 1 },
  { name: "documents", maxCount: 20 },
]);
