// Local dev entry. Loads .env, builds the Express app, listens on PORT.
// On Vercel this file is unused — api/index.ts is the entry point.
import "dotenv/config";
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
const app = buildApp();
app.listen(PORT, () => {
  console.log(`Partybus server listening on http://0.0.0.0:${PORT}`);
});
