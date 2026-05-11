import { MongoClient, type Db } from "mongodb";

// Cached at module scope so Vercel's warm function instances reuse the same
// connection pool instead of opening a new socket per request.
let clientPromise: Promise<MongoClient> | null = null;

export function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  clientPromise = new MongoClient(uri, {
    // Keep the pool small — serverless instances are short-lived and we don't
    // want to monopolize Atlas's free-tier connection cap.
    maxPoolSize: 5,
  }).connect();
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB || "partybus");
}
