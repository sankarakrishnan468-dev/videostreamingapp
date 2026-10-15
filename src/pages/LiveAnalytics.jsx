import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import "./Streamer.css";
import "./LiveStreaming.css";

function LiveAnalytics() {
  const { roomId } = useParams();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/live/${roomId}/stats`, {
          credentials: "include",
          cache: "no-store"
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load stream analytics.");
        if (active) {
          setStats(data);
          setError("");
        }
      } catch (loadError) {
        if (active) {
          console.error("Could not load live analytics:", loadError);
          setError(loadError.message || "Could not load live analytics.");
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [roomId]);

  return (
    <main className="viewer-page live-streaming-page">
      <header className="viewer-header">
        <Link className="brand" to="/"><span className="brand-mark" aria-hidden="true">S</span><span>streamline</span></Link>
        <nav aria-label="Main navigation">
          <Link to="/live">Live now</Link>
          <Link to="/streamer">Creator dashboard</Link>
        </nav>
      </header>
      <section className="live-home-page">
        <p className="stream-eyebrow">CREATOR STUDIO</p>
        <h1>Stream analytics</h1>
        {error && <p className="live-stream-error" role="alert">{error}</p>}
        {stats ? (
          <div className="live-stream-grid live-analytics-grid">
            <article className="live-analytics-card"><h2>Concurrent viewers</h2><p className="live-analytics-value">{stats.viewerCount}</p></article>
            <article className="live-analytics-card"><h2>Peak concurrent viewers</h2><p className="live-analytics-value">{stats.peakConcurrentViewers}</p></article>
            <article className="live-analytics-card"><h2>Total views</h2><p className="live-analytics-value">{stats.totalViews}</p></article>
            <article className="live-analytics-card"><h2>Stream status</h2><p className="live-analytics-value">{stats.streamStatus}</p></article>
          </div>
        ) : !error ? <p className="live-list-state" role="status">Loading analytics...</p> : null}
        <p className="live-analytics-disclaimer">
          Concurrent and peak viewers are active viewer sessions. Total views counts distinct viewer sessions;
          these figures do not represent playback quality or unique people.
        </p>
      </section>
    </main>
  );
}

export default LiveAnalytics;
