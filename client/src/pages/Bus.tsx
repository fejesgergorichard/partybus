import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api, type BusView } from "../api";

export default function Bus() {
  const { code = "" } = useParams();
  const [bus, setBus] = useState<BusView | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ok" | "not_joined" | "not_found"
  >("loading");
  const [url, setUrl] = useState("");
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const b = await api.getBus(code);
      setBus(b);
      // If you're not in the members list, you haven't joined yet on this device.
      // The server view returns members but doesn't tell you whether *you* are one,
      // so we just route to home with the code prefilled.
      setStatus("ok");
    } catch (e) {
      if (String(e).startsWith("404")) setStatus("not_found");
      else setStatus("not_joined");
    }
  }, [code]);

  useEffect(() => {
    // Fetch the bus first — the server marks `isHost` based on Spotify-user
    // match, so the host can re-enter their own bus from a new session without
    // re-joining.
    api
      .getBus(code)
      .then(async (b) => {
        const me = await api.me();
        const joined = me.bus?.code === code.toUpperCase();
        if (b.isHost || joined) {
          setBus(b);
          setStatus("ok");
        } else {
          setStatus("not_joined");
        }
      })
      .catch((e) => {
        if (String(e).startsWith("404")) setStatus("not_found");
        else setStatus("not_joined");
      });
  }, [code]);

  useEffect(() => {
    if (status !== "ok") return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [status, refresh]);

  if (status === "not_joined") {
    return <Navigate to={`/?code=${code.toUpperCase()}`} replace />;
  }
  if (status === "not_found") {
    return (
      <main className="container">
        <h1>🚌 Partybus</h1>
        <p>
          No bus with code <strong>{code.toUpperCase()}</strong>.
        </p>
        <a href="/">Back to home</a>
      </main>
    );
  }
  if (!bus)
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const next = await api.submit(code, url);
      setBus(next);
      setUrl("");
    } catch (e) {
      setSubmitErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleReveal() {
    if (!bus) return;
    const next = await api.reveal(code, !bus.revealed);
    setBus(next);
  }

  const shareUrl =
    bus.shareUrl ?? `${window.location.origin}/partybus/${bus.code}`;

  return (
    <main className="container">
      <header className="bus-header">
        <h1>
          <Link to="/" className="home-link">🚌</Link>{" "}
          {bus.code}
        </h1>
        <p className="tag">Host: {bus.hostDisplayName}</p>
      </header>

      <section className="card">
        <h2>Share the bus</h2>
        <p>Send this link to friends:</p>
        <code className="share">{shareUrl}</code>
        <button onClick={() => navigator.clipboard.writeText(shareUrl)}>
          Copy link
        </button>
      </section>

      {bus.isHost && (
        <section className="card host-controls">
          <h2>Host controls</h2>
          {bus.playlistUrl && (
            <p>
              Playlist:{" "}
              <a href={bus.playlistUrl} target="_blank" rel="noreferrer">
                open in Spotify ↗
              </a>
            </p>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={bus.revealed}
              onChange={toggleReveal}
            />
            Reveal Playlist
          </label>
        </section>
      )}

      <section className="card">
        <h2>Add a song</h2>
        <form onSubmit={submit}>
          <label>
            Spotify track URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://open.spotify.com/track/..."
              required
            />
          </label>
          <button type="submit" disabled={submitting || !url.trim()}>
            Add to bus
          </button>
        </form>
        {submitErr && <p className="error">{submitErr}</p>}
      </section>

      <section className="card">
        <h2>Passengers ({bus.members.length})</h2>
        <ul className="members">
          {bus.members.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Playlist ({bus.submissions.length})</h2>
        {!bus.revealed ? (
          <p className="muted">Hidden until the host reveals.</p>
        ) : bus.submissions.length === 0 ? (
          <p className="muted">No songs yet.</p>
        ) : (
          <ol className="submissions">
            {bus.submissions.map((s, i) => (
              <li key={i}>
                <div className="track">
                  <strong>{s.trackName}</strong>{" "}
                  <span className="muted">— {s.artistNames.join(", ")}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
