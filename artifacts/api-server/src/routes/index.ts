import { Router, type IRouter } from "express";
import civicaiRouter from "./civicai";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(civicaiRouter);

export default router;
