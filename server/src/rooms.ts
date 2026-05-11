import type { TokenSet } from "./spotify.js";

export type Submission = {
  trackId: string;
  trackUri: string;
  trackName: string;
  artistNames: string[];
  submitterSessionId: string;
  submitterName: string;
  addedAt: number;
};

export type Bus = {
  code: string;
  hostSessionId: string;
  hostUserId: string;
  hostDisplayName: string;
  tokens: TokenSet;
  playlistId: string;
  playlistUrl: string;
  revealed: boolean;
  members: Map<string, { name: string }>;
  submissions: Submission[];
  createdAt: number;
};

const buses = new Map<string, Bus>();

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I, O — easy to misread
function randomCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export function createBus(input: Omit<Bus, "code" | "members" | "submissions" | "createdAt" | "revealed">): Bus {
  let code = randomCode();
  while (buses.has(code)) code = randomCode();
  const bus: Bus = {
    ...input,
    code,
    revealed: false,
    members: new Map(),
    submissions: [],
    createdAt: Date.now(),
  };
  buses.set(code, bus);
  return bus;
}

export function getBus(code: string): Bus | undefined {
  return buses.get(code.toUpperCase());
}
