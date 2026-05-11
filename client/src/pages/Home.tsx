import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type MeView } from "../api";

export default function Home() {
  const [me, setMe] = useState<MeView | null>(null);
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get("code") || "").toUpperCase());
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const arrivedViaShareLink = Boolean(params.get("code"));

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ spotify: null, bus: null }));
  }, []);

  async function host() {
    setBusy(true);
    setErr(null);
    try {
      const bus = await api.createBus();
      navigate(`/partybus/${bus.code}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const c = code.trim().toUpperCase();
      const bus = await api.joinBus(c, name.trim());
      navigate(`/partybus/${bus.code}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <h1>🚌 Partybus</h1>
      <p className="tag">Everyone adds a song. Nobody knows who added what. Guess.</p>

      {!arrivedViaShareLink && (
        <section className="card">
          <h2>Host a partybus</h2>
          {me?.spotify ? (
            <>
              <p>Signed in as <strong>{me.spotify.displayName}</strong>.</p>
              <button onClick={host} disabled={busy}>Create new partybus</button>
            </>
          ) : (
            <a className="button" href="/auth/login">Log in with Spotify</a>
          )}
        </section>
      )}

      <section className="card">
        <h2>Join a partybus</h2>
        <form onSubmit={join}>
          <label>
            Code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={4}
              placeholder="ABCD"
              required
            />
          </label>
          <label>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Gergő"
              required
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 4 || !name.trim()}>
            Hop on
          </button>
        </form>
      </section>

      {err && <p className="error">{err}</p>}
    </main>
  );
}
