import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import cors from "cors";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  addTrackToPlaylist,
  buildAuthorizeUrl,
  createPlaylist,
  exchangeCode,
  getCurrentlyPlaying,
  getMe,
  getPlaylistTrackUris,
  getTrack,
  parseTrackId,
  refreshAccessToken,
  SpotifyApiError,
  type TokenSet,
} from "./spotify.js";
import {
  addSubmission,
  createBus,
  getBus,
  getBusesByHost,
  setRevealed,
  updateHostTokens,
  upsertMember,
  type Bus,
  type Submission,
} from "./rooms.js";
import { getMongoClient } from "./db.js";

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
    spotify?: TokenSet & { userId: string; displayName: string };
    busCode?: string;
    name?: string;
  }
}

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://127.0.0.1:5173";
const STATIC_DIR = process.env.STATIC_DIR;
const IS_PROD = process.env.NODE_ENV === "production";

// When a track is submitted while playback is in our playlist, drop the new
// track somewhere in this window past the currently-playing index. Avoids
// hijacking the immediate next-up slot, but keeps it close enough to land
// during the same session.
const INSERT_MIN_OFFSET = 3;
const INSERT_MAX_OFFSET = 15;
// Cap on tracks fetched while locating the currently-playing index. A party
// playlist won't approach this; the cap just bounds latency.
const PLAYLIST_TRACKS_MAX_FETCH = 500;

// In dev, friends on the LAN can't reach 127.0.0.1, so share links must use
// the Mac's LAN IP. In prod the browser's origin already is the public URL.
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

export function buildApp(): Express {
  const app = express();

  // Vercel and most PaaS sit behind a TLS-terminating proxy.
  app.set("trust proxy", 1);

  app.use(express.json());
  app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "dev-secret",
      resave: false,
      saveUninitialized: true,
      // Refresh the cookie on every response so an active guest's session
      // never silently expires mid-party.
      rolling: true,
      store: MongoStore.create({
        clientPromise: getMongoClient(),
        dbName: process.env.MONGODB_DB || "partybus",
        collectionName: "sessions",
        ttl: 60 * 60 * 24 * 7, // 7 days
      }),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: IS_PROD,
        // Without maxAge the cookie is a "browser session" cookie and mobile
        // browsers purge it when the tab is backgrounded. Match the store TTL.
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
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
    if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);
    if (!code || !state || state !== req.session.oauthState) {
      return res.redirect(`/?error=bad_state`);
    }
    try {
      const tokens = await exchangeCode(code);
      const me = await getMe(tokens.accessToken);
      req.session.spotify = {
        ...tokens,
        userId: me.id,
        displayName: me.display_name || me.id,
      };
      res.redirect(`/?logged_in=1`);
    } catch (e) {
      console.error(e);
      res.redirect(`/?error=oauth_failed`);
    }
  });

  app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ---------- Me ----------

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

  app.post("/api/bus", async (req, res) => {
    const sp = req.session.spotify;
    if (!sp) return res.status(401).json({ error: "not_logged_in" });
    try {
      const token = await ensureFreshSessionToken(req);
      const playlistName = `Partybus — ${new Date().toLocaleDateString()}`;
      const playlist = await createPlaylist(token, sp.userId, playlistName);
      const bus = await createBus({
        hostSessionId: req.sessionID,
        hostUserId: sp.userId,
        hostDisplayName: sp.displayName,
        tokens: { accessToken: sp.accessToken, refreshToken: sp.refreshToken, expiresAt: sp.expiresAt },
        playlistId: playlist.id,
        playlistUrl: playlist.external_urls.spotify,
      });
      req.session.busCode = bus.code;
      req.session.name = sp.displayName;
      res.json(viewOfBus(bus, req));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "create_failed", detail: String(e) });
    }
  });

  app.post("/api/bus/:code/join", async (req, res) => {
    const name = (req.body?.name as string | undefined)?.trim();
    if (!name) return res.status(400).json({ error: "name_required" });
    const bus = await upsertMember(req.params.code, req.sessionID, name);
    if (!bus) return res.status(404).json({ error: "not_found" });
    req.session.busCode = bus.code;
    req.session.name = name;
    res.json(viewOfBus(bus, req));
  });

  app.get("/api/bus/:code", async (req, res) => {
    const bus = await getBus(req.params.code);
    if (!bus) return res.status(404).json({ error: "not_found" });
    res.json(viewOfBus(bus, req));
  });

  app.post("/api/bus/:code/submit", async (req, res) => {
    const bus = await getBus(req.params.code);
    if (!bus) return res.status(404).json({ error: "not_found" });
    const member = bus.members.find((m) => m.sessionId === req.sessionID);
    const host = isHostOfBus(req, bus);
    if (!member && !host) return res.status(403).json({ error: "not_in_bus" });
    const url = (req.body?.url as string | undefined) ?? "";
    const trackId = parseTrackId(url);
    if (!trackId) return res.status(400).json({ error: "bad_url" });
    try {
      const token = await freshTokenForBus(bus);
      const track = await getTrack(token, trackId);
      const { position, reason } = await pickInsertionPosition(bus, token);
      // pickInsertionPosition may refresh and persist new tokens; re-read.
      const writeToken = bus.tokens.accessToken;
      await addTrackToPlaylist(
        writeToken,
        bus.playlistId,
        track.uri,
        position ?? undefined,
      );
      const localPosition = position ?? bus.submissions.length;
      console.log(
        `[partybus] submit ${bus.code} "${track.name}": ${
          position === null ? "append" : `insert pos=${position}`
        }, ${reason}`,
      );
      const submission: Submission = {
        trackId: track.id,
        trackUri: track.uri,
        trackName: track.name,
        artistNames: track.artists.map((a) => a.name),
        submitterSessionId: req.sessionID,
        submitterName: member?.name ?? bus.hostDisplayName,
        addedAt: Date.now(),
      };
      const updated = await addSubmission(bus.code, submission, localPosition);
      res.json(viewOfBus(updated ?? bus, req));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "submit_failed", detail: String(e) });
    }
  });

  app.post("/api/bus/:code/reveal", async (req, res) => {
    const bus = await getBus(req.params.code);
    if (!bus) return res.status(404).json({ error: "not_found" });
    if (!isHostOfBus(req, bus)) return res.status(403).json({ error: "not_host" });
    const updated = await setRevealed(req.params.code, Boolean(req.body?.revealed));
    res.json(viewOfBus(updated ?? bus, req));
  });

  app.get("/api/my-buses", async (req, res) => {
    const sp = req.session.spotify;
    if (!sp) return res.status(401).json({ error: "not_logged_in" });
    const list = await getBusesByHost(sp.userId);
    res.json(
      list.map((b) => ({
        code: b.code,
        createdAt: b.createdAt,
        playlistUrl: b.playlistUrl,
        revealed: b.revealed,
        submissionCount: b.submissions.length,
      })),
    );
  });

  // ---------- Static frontend (prod) ----------

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

  return app;
}

// ---------- Helpers ----------

async function ensureFreshSessionToken(req: Request): Promise<string> {
  const sp = req.session.spotify!;
  if (Date.now() < sp.expiresAt) return sp.accessToken;
  const next = await refreshAccessToken(sp.refreshToken);
  req.session.spotify = { ...sp, ...next, refreshToken: next.refreshToken || sp.refreshToken };
  return next.accessToken;
}

async function freshTokenForBus(bus: Bus): Promise<string> {
  if (Date.now() < bus.tokens.expiresAt) return bus.tokens.accessToken;
  const next = await refreshAccessToken(bus.tokens.refreshToken);
  await updateHostTokens(bus.code, next);
  bus.tokens = next;
  return next.accessToken;
}

// Decide where a new submission lands in the host's Spotify playlist.
// Returns `position: null` to mean "append to end" — caller omits the
// position parameter so Spotify appends naturally.
async function pickInsertionPosition(
  bus: Bus,
  initialToken: string,
): Promise<{ position: number | null; reason: string }> {
  let token = initialToken;
  let retriedOn401 = false;
  while (true) {
    try {
      const playing = await getCurrentlyPlaying(token);
      if (!playing) return { position: null, reason: "nothing_playing" };
      const ourContext = `spotify:playlist:${bus.playlistId}`;
      if (playing.contextUri !== ourContext) {
        return { position: null, reason: "wrong_context" };
      }
      const uris = await getPlaylistTrackUris(token, bus.playlistId, {
        cap: PLAYLIST_TRACKS_MAX_FETCH,
      });
      const currentIdx = uris.indexOf(playing.itemUri);
      if (currentIdx < 0) {
        return { position: null, reason: "current_not_found" };
      }
      const span = INSERT_MAX_OFFSET - INSERT_MIN_OFFSET + 1;
      const offset = INSERT_MIN_OFFSET + Math.floor(Math.random() * span);
      const position = Math.min(currentIdx + offset, uris.length);
      return {
        position,
        reason: `insert-after-current (current=${currentIdx} playlistLen=${uris.length} offset=${offset})`,
      };
    } catch (e) {
      if (!retriedOn401 && e instanceof SpotifyApiError && e.status === 401) {
        retriedOn401 = true;
        try {
          const next = await refreshAccessToken(bus.tokens.refreshToken);
          await updateHostTokens(bus.code, next);
          bus.tokens = next;
          token = next.accessToken;
          continue;
        } catch (refreshErr) {
          return {
            position: null,
            reason: `api_error: refresh_failed: ${String(refreshErr)}`,
          };
        }
      }
      return { position: null, reason: `api_error: ${String(e)}` };
    }
  }
}

function isHostOfBus(req: Request, bus: Bus): boolean {
  if (bus.hostSessionId === req.sessionID) return true;
  const spotifyUserId = req.session.spotify?.userId;
  return spotifyUserId !== undefined && bus.hostUserId === spotifyUserId;
}

function viewOfBus(bus: Bus, req: Request) {
  const viewerSessionId = req.sessionID;
  const isHost = isHostOfBus(req, bus);
  const showSubmitters = bus.revealed || isHost;
  return {
    code: bus.code,
    isHost,
    revealed: bus.revealed,
    hostDisplayName: bus.hostDisplayName,
    playlistUrl: isHost ? bus.playlistUrl : null,
    shareUrl: SHARE_BASE ? `${SHARE_BASE}/partybus/${bus.code}` : null,
    members: bus.members.map((m) => m.name),
    submissions: bus.submissions.map((s) => ({
      trackName: s.trackName,
      artistNames: s.artistNames,
      submitterName: showSubmitters ? s.submitterName : null,
      isMine: s.submitterSessionId === viewerSessionId,
      addedAt: s.addedAt,
    })),
  };
}
