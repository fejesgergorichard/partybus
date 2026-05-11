import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import cors from "cors";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  addTrackToPlaylist,
  buildAuthorizeUrl,
  createPlaylist,
  exchangeCode,
  getMe,
  getTrack,
  parseTrackId,
  refreshAccessToken,
  type TokenSet,
} from "./spotify.js";
import { createBus, getBus, type Bus, type Submission } from "./rooms.js";

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
    spotify?: TokenSet & { userId: string; displayName: string };
    busCode?: string;
    name?: string;
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5173";
const STATIC_DIR = process.env.STATIC_DIR;
const IS_PROD = process.env.NODE_ENV === "production";

// In dev, friends on the LAN can't reach 127.0.0.1, so share links must use
// the Mac's LAN IP. In prod, the browser's origin already is the public URL.
function detectShareBase(): string | null {
  if (IS_PROD) return null;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return `http://${addr.address}:5173`;
      }
    }
  }
  return null;
}
const SHARE_BASE = detectShareBase();
console.log(`[partybus] share base = ${SHARE_BASE ?? "(browser origin)"}`);

// Fly (and most PaaS) sit behind a TLS-terminating proxy.
app.set("trust proxy", 1);

app.use(express.json());
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: "lax", secure: IS_PROD },
  }),
);

// ---------- Health ----------

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// ---------- Auth ----------

app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(buildAuthorizeUrl(state));
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return res.redirect(`${FRONTEND_ORIGIN}/?error=${encodeURIComponent(error)}`);
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect(`${FRONTEND_ORIGIN}/?error=bad_state`);
  }
  try {
    const tokens = await exchangeCode(code);
    const me = await getMe(tokens.accessToken);
    req.session.spotify = {
      ...tokens,
      userId: me.id,
      displayName: me.display_name || me.id,
    };
    res.redirect(`${FRONTEND_ORIGIN}/?logged_in=1`);
  } catch (e) {
    console.error(e);
    res.redirect(`${FRONTEND_ORIGIN}/?error=oauth_failed`);
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Me ----------

// ---------- Debug probe (dev only) ----------
// Hits a few Spotify endpoints with the current session's token to isolate
// scope vs. account-permission vs. write-specific failures.
app.get("/api/debug/probe", async (req, res) => {
  if (IS_PROD) return res.status(404).end();
  const sp = req.session.spotify;
  if (!sp) return res.status(401).json({ error: "not_logged_in" });
  const token = await ensureFreshSessionToken(req);

  async function probe(label: string, url: string, init: RequestInit = {}) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      });
      const body = await r.text();
      return { label, status: r.status, ok: r.ok, body: body.slice(0, 300) };
    } catch (e) {
      return { label, error: String(e) };
    }
  }

  const results = [
    await probe("GET /me", "https://api.spotify.com/v1/me"),
    await probe(
      "POST playlist (private)",
      `https://api.spotify.com/v1/users/${sp.userId}/playlists`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Partybus probe private", public: false }),
      },
    ),
    await probe(
      "POST playlist (public)",
      `https://api.spotify.com/v1/users/${sp.userId}/playlists`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Partybus probe public", public: true }),
      },
    ),
  ];

  res.json({ userId: sp.userId, results });
});

app.get("/api/me", (req, res) => {
  const s = req.session;
  res.json({
    spotify: s.spotify
      ? { userId: s.spotify.userId, displayName: s.spotify.displayName }
      : null,
    bus: s.busCode ? { code: s.busCode, name: s.name } : null,
  });
});

// ---------- Bus ----------

async function freshToken(bus: Bus): Promise<string> {
  if (Date.now() < bus.tokens.expiresAt) return bus.tokens.accessToken;
  const next = await refreshAccessToken(bus.tokens.refreshToken);
  bus.tokens = next;
  return next.accessToken;
}

app.post("/api/bus", async (req, res) => {
  const sp = req.session.spotify;
  if (!sp) return res.status(401).json({ error: "not_logged_in" });
  try {
    const token = await ensureFreshSessionToken(req);
    const playlistName = `Partybus — ${new Date().toLocaleDateString()}`;
    const playlist = await createPlaylist(token, sp.userId, playlistName);
    const bus = createBus({
      hostSessionId: req.sessionID,
      hostUserId: sp.userId,
      hostDisplayName: sp.displayName,
      tokens: { accessToken: sp.accessToken, refreshToken: sp.refreshToken, expiresAt: sp.expiresAt },
      playlistId: playlist.id,
      playlistUrl: playlist.external_urls.spotify,
    });
    bus.members.set(req.sessionID, { name: sp.displayName });
    req.session.busCode = bus.code;
    req.session.name = sp.displayName;
    res.json(viewOfBus(bus, req.sessionID));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "create_failed", detail: String(e) });
  }
});

app.post("/api/bus/:code/join", (req, res) => {
  const bus = getBus(req.params.code);
  if (!bus) return res.status(404).json({ error: "not_found" });
  const name = (req.body?.name as string | undefined)?.trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  bus.members.set(req.sessionID, { name });
  req.session.busCode = bus.code;
  req.session.name = name;
  res.json(viewOfBus(bus, req.sessionID));
});

app.get("/api/bus/:code", (req, res) => {
  const bus = getBus(req.params.code);
  if (!bus) return res.status(404).json({ error: "not_found" });
  res.json(viewOfBus(bus, req.sessionID));
});

app.post("/api/bus/:code/submit", async (req, res) => {
  const bus = getBus(req.params.code);
  if (!bus) return res.status(404).json({ error: "not_found" });
  const member = bus.members.get(req.sessionID);
  if (!member) return res.status(403).json({ error: "not_in_bus" });
  const url = (req.body?.url as string | undefined) ?? "";
  const trackId = parseTrackId(url);
  if (!trackId) return res.status(400).json({ error: "bad_url" });
  try {
    const token = await freshToken(bus);
    const track = await getTrack(token, trackId);
    const position = Math.floor(Math.random() * (bus.submissions.length + 1));
    await addTrackToPlaylist(token, bus.playlistId, track.uri, position);
    const submission: Submission = {
      trackId: track.id,
      trackUri: track.uri,
      trackName: track.name,
      artistNames: track.artists.map((a) => a.name),
      submitterSessionId: req.sessionID,
      submitterName: member.name,
      addedAt: Date.now(),
    };
    // keep server-side list in playlist insertion order
    bus.submissions.splice(position, 0, submission);
    res.json(viewOfBus(bus, req.sessionID));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "submit_failed", detail: String(e) });
  }
});

app.post("/api/bus/:code/reveal", (req, res) => {
  const bus = getBus(req.params.code);
  if (!bus) return res.status(404).json({ error: "not_found" });
  if (bus.hostSessionId !== req.sessionID) return res.status(403).json({ error: "not_host" });
  const revealed = Boolean(req.body?.revealed);
  bus.revealed = revealed;
  res.json(viewOfBus(bus, req.sessionID));
});

// ---------- Helpers ----------

async function ensureFreshSessionToken(req: Request): Promise<string> {
  const sp = req.session.spotify!;
  if (Date.now() < sp.expiresAt) return sp.accessToken;
  const next = await refreshAccessToken(sp.refreshToken);
  req.session.spotify = { ...sp, ...next, refreshToken: next.refreshToken || sp.refreshToken };
  return next.accessToken;
}

function viewOfBus(bus: Bus, viewerSessionId: string) {
  const isHost = bus.hostSessionId === viewerSessionId;
  const showSubmitters = bus.revealed || isHost;
  return {
    code: bus.code,
    isHost,
    revealed: bus.revealed,
    hostDisplayName: bus.hostDisplayName,
    playlistUrl: isHost ? bus.playlistUrl : null,
    shareUrl: SHARE_BASE ? `${SHARE_BASE}/partybus/${bus.code}` : null,
    members: [...bus.members.values()].map((m) => m.name),
    submissions: bus.submissions.map((s) => ({
      trackName: s.trackName,
      artistNames: s.artistNames,
      submitterName: showSubmitters ? s.submitterName : null,
      isMine: s.submitterSessionId === viewerSessionId,
      addedAt: s.addedAt,
    })),
  };
}

// In production, serve the built React app from STATIC_DIR and fall back to
// index.html for any non-API GET so React Router handles client routes.
if (STATIC_DIR) {
  app.use(express.static(STATIC_DIR));
  app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal" });
});

app.listen(PORT, () => {
  console.log(`Partybus server listening on http://0.0.0.0:${PORT}`);
});
