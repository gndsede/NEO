import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate } from "../../middleware/auth.js";
import { badgeController } from "./badge.controller.js";

// mergeParams: true para herdar :id de /workers/:id
const router = Router({ mergeParams: true });

router.use(authenticate);

router.get("/", asyncHandler(badgeController.generate));
router.get("/qrcode.png", asyncHandler(badgeController.qrcodePng));

export const badgeRoutes = router;
