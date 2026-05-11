export type BusView = {
  code: string;
  isHost: boolean;
  revealed: boolean;
  hostDisplayName: string;
  playlistUrl: string | null;
  shareUrl: string | null;
  members: string[];
  submissions: {
    trackName: string;
    artistNames: string[];
    submitterName: string | null;
    isMine: boolean;
    addedAt: number;
  }[];
};

export type MeView = {
  spotify: { userId: string; displayName: string } | null;
  bus: { code: string; name: string } | null;
};

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => http<MeView>("/api/me"),
  createBus: () => http<BusView>("/api/bus", { method: "POST" }),
  joinBus: (code: string, name: string) =>
    http<BusView>(`/api/bus/${code}/join`, { method: "POST", body: JSON.stringify({ name }) }),
  getBus: (code: string) => http<BusView>(`/api/bus/${code}`),
  submit: (code: string, url: string) =>
    http<BusView>(`/api/bus/${code}/submit`, { method: "POST", body: JSON.stringify({ url }) }),
  reveal: (code: string, revealed: boolean) =>
    http<BusView>(`/api/bus/${code}/reveal`, { method: "POST", body: JSON.stringify({ revealed }) }),
};
