import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./Home.css";

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  );
}

function BroadcastIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 9a10 10 0 0 0 0 6M2 5a16 16 0 0 0 0 14m17-10a10 10 0 0 1 0 6m3-10a16 16 0 0 1 0 14" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h12m-5-5 5 5-5 5" />
    </svg>
  );
}

function Home() {
  const navigate = useNavigate();
  const [inviteInput, setInviteInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [meetingPassword, setMeetingPassword] = useState("");
  const [createError, setCreateError] = useState("");
  const [creatingRoom, setCreatingRoom] = useState(false);

  const joinCall = (event) => {
    event.preventDefault();
    const input = inviteInput.trim();
    let callId = input;

    if (input.includes("://")) {
      try {
        callId = new URL(input).pathname.split("/").filter(Boolean).at(-1) || "";
      } catch {
        setJoinError("Enter a valid call link or 32-character room code.");
        return;
      }
    }

    if (!/^[a-f\d]{32}$/i.test(callId)) {
      setJoinError("Enter a valid call link or 32-character room code.");
      return;
    }

    setJoinError("");
    navigate(`/call/${callId}`);
  };

  const createCall = async () => {
    setCreateError("");
    setCreatingRoom(true);
    try {
      const response = await fetch("/api/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: meetingPassword })
      });
      const responseBody = await response.text();
      let data;
      try {
        data = JSON.parse(responseBody);
      } catch (error) {
        console.error("Private room API returned a non-JSON response:", error);
        throw new Error(
          "The call server is out of date. Restart the backend and try again.",
          { cause: error }
        );
      }
      if (!response.ok) throw new Error(data.error || "Could not create a private call.");
      if (!/^[a-f\d]{32}$/i.test(data.roomId) || !/^[a-f\d]{64}$/i.test(data.hostKey)) {
        throw new Error("The call server returned invalid room details.");
      }
      window.sessionStorage.setItem(`streamline.callHost.${data.roomId}`, data.hostKey);
      navigate(`/call/${data.roomId}`);
    } catch (error) {
      console.error("Could not create private call:", error);
      setCreateError(error.message || "Could not reach the call server.");
    } finally {
      setCreatingRoom(false);
    }
  };

  return (
    <main className="home">
      <header className="home-header">
        <Link className="brand" to="/" aria-label="Streamline home">
          <span className="brand-mark"><BroadcastIcon /></span>
          <span>streamline</span>
        </Link>
        <Link className="header-note" to="/videos">Video library</Link>
        <Link className="header-note" to="/login">Sign in</Link>
      </header>

      <section className="hero">
        <p className="eyebrow"><span className="eyebrow-dot" /> VIDEO, YOUR WAY</p>
        <h1>Bring people<br /><span>closer together.</span></h1>
        <p className="hero-copy">
          Catch up face to face or share something with the world.
          Pick a room and you&apos;re ready to go.
        </p>
      </section>

      <section className="modes" aria-label="Choose how to connect">
        <article className="mode-card meeting-card">
          <div className="card-topline">
            <span className="mode-icon meeting-icon"><VideoIcon /></span>
            <span className="mode-label">JUST FOR YOU</span>
          </div>
          <div className="card-copy">
            <h2>Private calls</h2>
            <p>
              Meet face to face in a private space. Perfect for one-on-ones,
              catch-ups, and small team conversations.
            </p>
          </div>
          <div className="call-room-options">
            <label htmlFor="meeting-password">Meeting password (optional)</label>
            <input
              id="meeting-password"
              type="password"
              autoComplete="new-password"
              minLength={meetingPassword ? 6 : undefined}
              maxLength={72}
              placeholder="At least 6 characters"
              value={meetingPassword}
              onChange={(event) => setMeetingPassword(event.target.value)}
            />
            {createError && <p role="alert">{createError}</p>}
          </div>
          <div className="card-action">
            <button
              className="primary-action"
              type="button"
              onClick={() => void createCall()}
              disabled={creatingRoom}
            >
              {creatingRoom ? "Creating room..." : "Create private call"} <ArrowIcon />
            </button>
            <span className="action-hint">Invite up to three guests with a private link</span>
          </div>
          <form className="join-call-form" onSubmit={joinCall}>
            <label htmlFor="call-invite">Have a call link?</label>
            <div className="join-call-controls">
              <input
                id="call-invite"
                type="text"
                autoComplete="off"
                placeholder="Paste link or room code"
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
                aria-describedby={joinError ? "call-join-error" : undefined}
              />
              <button type="submit">Join</button>
            </div>
            {joinError && <p className="join-call-error" id="call-join-error" role="alert">{joinError}</p>}
          </form>
          <div className="card-glow meeting-glow" aria-hidden="true" />
        </article>

        <article className="mode-card live-card">
          <div className="card-topline">
            <span className="mode-icon live-icon"><BroadcastIcon /></span>
            <span className="mode-label">SHARE IT LIVE</span>
          </div>
          <div className="card-copy">
            <h2>Go live</h2>
            <p>
              Start a live broadcast and let viewers tune in from anywhere.
              Your next stream is just one click away.
            </p>
          </div>
          <div className="card-action">
            <Link className="primary-action" to="/streamer">
              Start streaming <ArrowIcon />
            </Link>
            <Link className="text-action" to="/viewer">
              Watch a stream <ArrowIcon />
            </Link>
          </div>
          <div className="card-glow live-glow" aria-hidden="true" />
        </article>
      </section>

      <footer className="home-footer">
        <span>One place for real-time video.</span>
        <span className="footer-status"><span /> Streaming is ready</span>
      </footer>
    </main>
  );
}

export default Home;
