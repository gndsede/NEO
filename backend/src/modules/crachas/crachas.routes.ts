import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { BadRequest, Unauthorized } from "../../lib/errors.js";
import * as crachasService from "./crachas.service.js";

const TEMPLATE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!TEMPLATE_MIME.has(file.mimetype)) {
      cb(BadRequest("Template deve ser uma imagem JPEG, PNG ou WEBP"));
      return;
    }
    cb(null, true);
  },
});

const router = Router();
router.use(authenticate);
router.use(requireCapability("cracha.generate"));

// POST /crachas/worker/:workerId  — individual
router.post(
  "/worker/:workerId",
  upload.single("template"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const template = req.file;
    if (!template) {
      res.status(400).json({ error: "Campo 'template' obrigatório" });
      return;
    }
    const pdfBuf = await crachasService.gerarPorWorker(
      template.buffer,
      String(req.params.workerId),
      req.user,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="cracha.pdf"');
    res.send(pdfBuf);
  }),
);

// POST /crachas/lote  — todos os colaboradores ativos (ou lista filtrada)
router.post(
  "/lote",
  upload.single("template"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const template = req.file;
    if (!template) {
      res.status(400).json({ error: "Campo 'template' obrigatório" });
      return;
    }
    let workerIds: string[] | undefined;
    const rawIds = req.body.workerIds as string | undefined;
    if (rawIds) {
      try {
        workerIds = JSON.parse(rawIds) as string[];
      } catch {
        res.status(400).json({ error: "workerIds deve ser um JSON array de strings" });
        return;
      }
    }
    const { pdf, gerados, falhas } = await crachasService.gerarLote(
      template.buffer,
      req.user,
      workerIds,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="CRACHAS_LOTE.pdf"');
    // O corpo é binário: o resumo do lote vai em cabeçalhos (expostos no CORS)
    // para o front avisar quando alguém ficou de fora.
    res.setHeader("X-Crachas-Gerados", String(gerados));
    res.setHeader("X-Crachas-Falhas", String(falhas.length));
    res.send(pdf);
  }),
);

export const crachasRoutes = router;
