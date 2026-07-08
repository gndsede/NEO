import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { rdoController } from "./rdo.controller.js";

const router = Router();
router.use(authenticate);

router.get(
  "/",
  requireCapability("rdo.view", "rdo.manage", "rdo.approve"),
  asyncHandler(rdoController.list),
);
router.get(
  "/:id",
  requireCapability("rdo.view", "rdo.manage", "rdo.approve"),
  asyncHandler(rdoController.getById),
);
router.post("/", requireCapability("rdo.manage"), asyncHandler(rdoController.create));
router.patch("/:id", requireCapability("rdo.manage"), asyncHandler(rdoController.update));
router.patch("/:id/submit", requireCapability("rdo.manage"), asyncHandler(rdoController.submitForApproval));
router.patch("/:id/approve", requireCapability("rdo.approve"), asyncHandler(rdoController.approve));
router.patch("/:id/reject", requireCapability("rdo.approve"), asyncHandler(rdoController.reject));
router.delete("/:id", requireCapability("rdo.manage"), asyncHandler(rdoController.remove));
router.get(
  "/export/pdf",
  requireCapability("rdo.view", "rdo.manage", "rdo.approve"),
  asyncHandler(rdoController.exportPdf),
);

export const rdoRoutes = router;
