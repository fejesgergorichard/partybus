// Vercel serverless entry. Vercel routes all /api/* and /auth/* requests to
// this function (see vercel.json rewrites). The exported Express app handles
// them like any other Node http server.
import { buildApp } from "../server/src/app.js";

const app = buildApp();
export default app;
