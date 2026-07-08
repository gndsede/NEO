import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { badgeController } from "./badge.controller.js";

// mergeParams: true para herdar :id de /workers/:id
const router = Router({ mergeParams: true });

router.use(authenticate);
// Crachá expõe CPF/foto — restringe a quem trabalha com crachás ou colaboradores.
router.use(
  requireCapability("cracha.view", "cracha.generate", "colaboradores.view", "colaboradores.manage"),
);

router.get("/", asyncHandler(badgeController.generate));
router.get("/qrcode.png", asyncHandler(badgeController.qrcodePng));

export const badgeRoutes = router;
