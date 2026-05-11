import type { TokenSet } from "./spotify.js";
import { getDb } from "./db.js";

export type Submission = {
  trackId: string;
  trackUri: string;
  trackName: string;
  artistNames: string[];
  submitterSessionId: string;
  submitterName: string;
  addedAt: number;
};

export type Member = { sessionId: string; name: string };

export type Bus = {
  code: string;
  hostSessionId: string;
  hostUserId: string;
  hostDisplayName: string;
  tokens: TokenSet;
  playlistId: string;
  playlistUrl: string;
  revealed: boolean;
  members: Member[];
  submissions: Submission[];
  createdAt: number;
};

const COLLECTION = "buses";

async function buses() {
  const db = await getDb();
  return db.collection<Bus>(COLLECTION);
}

// One-time-per-process index creation. Idempotent so safe to call repeatedly.
let indexEnsured = false;
async function ensureIndexes() {
  if (indexEnsured) return;
  const col = await buses();
  await col.createIndex({ code: 1 }, { unique: true });
  indexEnsured = true;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O — easy to misread
function randomCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export async function createBus(
  input: Omit<Bus, "code" | "members" | "submissions" | "createdAt" | "revealed">,
): Promise<Bus> {
  await ensureIndexes();
  const col = await buses();
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    const bus: Bus = {
      ...input,
      code,
      revealed: false,
      members: [{ sessionId: input.hostSessionId, name: input.hostDisplayName }],
      submissions: [],
      createdAt: Date.now(),
    };
    try {
      await col.insertOne(bus);
      return bus;
    } catch (e: unknown) {
      // Duplicate key on `code` — retry. Anything else: bubble up.
      if (isDuplicateKey(e)) continue;
      throw e;
    }
  }
  throw new Error("Failed to allocate a unique bus code after 20 attempts");
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: number }).code === 11000;
}

export async function getBus(code: string): Promise<Bus | null> {
  const col = await buses();
  return await col.findOne({ code: code.toUpperCase() });
}

export async function upsertMember(code: string, sessionId: string, name: string): Promise<Bus | null> {
  const col = await buses();
  const upper = code.toUpperCase();
  // Remove any prior entry for this session, then push the new one. Two writes
  // but the alternative (positional-array upsert with arrayFilters) is fiddlier.
  await col.updateOne({ code: upper }, { $pull: { members: { sessionId } } });
  const after = await col.findOneAndUpdate(
    { code: upper },
    { $push: { members: { sessionId, name } } },
    { returnDocument: "after" },
  );
  return after;
}

export async function addSubmission(
  code: string,
  submission: Submission,
  position: number,
): Promise<Bus | null> {
  const col = await buses();
  const after = await col.findOneAndUpdate(
    { code: code.toUpperCase() },
    { $push: { submissions: { $each: [submission], $position: position } } },
    { returnDocument: "after" },
  );
  return after;
}

export async function setRevealed(code: string, revealed: boolean): Promise<Bus | null> {
  const col = await buses();
  return await col.findOneAndUpdate(
    { code: code.toUpperCase() },
    { $set: { revealed } },
    { returnDocument: "after" },
  );
}

export async function updateHostTokens(code: string, tokens: TokenSet): Promise<void> {
  const col = await buses();
  await col.updateOne({ code: code.toUpperCase() }, { $set: { tokens } });
}
