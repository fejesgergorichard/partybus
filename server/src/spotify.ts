const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

const clientId = () => required("SPOTIFY_CLIENT_ID");
const clientSecret = () => required("SPOTIFY_CLIENT_SECRET");
const redirectUri = () => required("SPOTIFY_REDIRECT_URI");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const SCOPES = [
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export async function exchangeCode(code: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  return tokenRequest(body);
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const next = await tokenRequest(body);
  return { ...next, refreshToken: next.refreshToken || refreshToken };
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString(
    "base64",
  );
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  console.log(
    `[spotify] token granted, scopes: ${json.scope ?? "(none reported)"}`,
  );
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresAt: Date.now() + json.expires_in * 1000 - 30_000,
  };
}

async function api<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify API ${res.status} ${path}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getMe(
  token: string,
): Promise<{ id: string; display_name: string | null }> {
  return api(token, "/me");
}

export async function createPlaylist(
  token: string,
  userId: string,
  name: string,
): Promise<{ id: string; external_urls: { spotify: string } }> {
  return api(token, `/me/playlists`, {
    method: "POST",
    body: JSON.stringify({
      name,
      public: false,
      description: "Created by Partybus — guess who added each song.",
    }),
  });
}

export async function getTrack(
  token: string,
  trackId: string,
): Promise<{
  id: string;
  name: string;
  artists: { name: string }[];
  uri: string;
}> {
  return api(token, `/tracks/${trackId}`);
}

export async function addTrackToPlaylist(
  token: string,
  playlistId: string,
  trackUri: string,
  position?: number,
): Promise<void> {
  const body: { uris: string[]; position?: number } = { uris: [trackUri] };
  if (position !== undefined) body.position = position;
  await api(token, `/playlists/${playlistId}/items`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Accepts an open.spotify.com URL or a spotify:track: URI and returns the track id. */
export function parseTrackId(input: string): string | null {
  return parseSpotifyId(input, "track");
}

/** Accepts an open.spotify.com URL, spotify:playlist: URI, or bare id. */
export function parsePlaylistId(input: string): string | null {
  return parseSpotifyId(input, "playlist");
}

function parseSpotifyId(
  input: string,
  kind: "track" | "playlist",
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const uriMatch = trimmed.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)`));
  if (uriMatch) return uriMatch[1];
  try {
    const url = new URL(trimmed);
    const m = url.pathname.match(new RegExp(`/${kind}/([A-Za-z0-9]+)`));
    if (m) return m[1];
  } catch {
    // bare-id case below
  }
  // Spotify ids are 22 base62 chars, but allow any length of base62 for flexibility.
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  return null;
}
