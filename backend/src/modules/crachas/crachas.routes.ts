import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate } from "../../middleware/auth.js";
import { Unauthorized } from "../../lib/errors.js";
import * as crachasService from "./crachas.service.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = Router();
router.use(authenticate);

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
      req.user.companyId,
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
    const pdfBuf = await crachasService.gerarLote(
      template.buffer,
      req.user.companyId,
      workerIds,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="CRACHAS_LOTE.pdf"');
    res.send(pdfBuf);
  }),
);

export const crachasRoutes = router;
