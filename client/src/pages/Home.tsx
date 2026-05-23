import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, type MeView, type MyBus } from "../api";

const GILMORE_NAMES = [
  "Luke", "Rory", "Lorelai", "Christopher", "Sookie", "Lane", "Paris",
  "Dean", "Jess", "Logan", "Emily", "Richard", "Kirk", "Michel", "Taylor",
  "Babette", "Miss Patty", "Zach", "Dave", "Max",
];

export default function Home() {
  const [me, setMe] = useState<MeView | null>(null);
  const [myBuses, setMyBuses] = useState<MyBus[] | null>(null);
  const [params] = useSearchParams();
  const [code, setCode] = useState((params.get("code") || "").toUpperCase());
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const arrivedViaShareLink = Boolean(params.get("code"));
  const namePlaceholder = useMemo(
    () => GILMORE_NAMES[Math.floor(Math.random() * GILMORE_NAMES.length)],
    [],
  );

  const loadMyBuses = useCallback(() => {
    api.myBuses().then(setMyBuses).catch(() => setMyBuses([]));
  }, []);

  useEffect(() => {
    api.me().then((m) => {
      setMe(m);
      if (m.spotify) loadMyBuses();
    }).catch(() => setMe({ spotify: null, bus: null }));
  }, [loadMyBuses]);

  async function toggleReveal(b: MyBus) {
    await api.reveal(b.code, !b.revealed);
    loadMyBuses();
  }

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
      const effectiveName = name.trim() || namePlaceholder;
      const bus = await api.joinBus(c, effectiveName);
      navigate(`/partybus/${bus.code}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container">
      <h1><Link to="/" className="home-link">🚌</Link> Partybus</h1>
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

      {!arrivedViaShareLink && me?.spotify && myBuses && myBuses.length > 0 && (
        <section className="card">
          <h2>Your buses</h2>
          <ul className="my-buses">
            {myBuses.map((b) => (
              <li key={b.code}>
                <div className="my-bus-row">
                  <span className="my-bus-code">{b.code}</span>
                  <span className="muted small">
                    {b.submissionCount} song{b.submissionCount === 1 ? "" : "s"}
                    {" · "}
                    {b.revealed ? "revealed" : "hidden"}
                  </span>
                </div>
                <div className="my-bus-actions">
                  <button onClick={() => navigate(`/partybus/${b.code}`)}>Open</button>
                  <a className="button" href={b.playlistUrl} target="_blank" rel="noreferrer">
                    Playlist ↗
                  </a>
                  <button onClick={() => toggleReveal(b)}>
                    {b.revealed ? "Hide" : "Reveal"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
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
              placeholder={namePlaceholder}
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 4}>
            Hop on
          </button>
        </form>
      </section>

      {err && <p className="error">{err}</p>}
    </main>
  );
}
