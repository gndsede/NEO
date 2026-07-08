import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { upload } from "../../middleware/upload.js";
import { documentController } from "./document.controller.js";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  requireCapability("documentos.view", "documentos.attach", "documentos.approve"),
  asyncHandler(documentController.list),
);
router.get(
  "/:id",
  requireCapability("documentos.view", "documentos.attach", "documentos.approve"),
  asyncHandler(documentController.getById),
);

router.post(
  "/",
  requireCapability("documentos.attach"),
  upload.single("file"),
  asyncHandler(documentController.attach),
);

/**
 * Workflow de aprovação documental — somente papéis com poder de avaliação.
 * Ambos registram reviewedById/reviewedAt para auditoria.
 */
router.patch(
  "/:id/approve",
  requireCapability("documentos.approve"),
  asyncHandler(documentController.approve),
);

router.patch(
  "/:id/reject",
  requireCapability("documentos.approve"),
  asyncHandler(documentController.reject),
);

export const documentRoutes = router;
