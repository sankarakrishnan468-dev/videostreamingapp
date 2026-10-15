import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./AccountDashboard.css";

async function fetchAccountData(url) {
  const response = await fetch(url, { credentials: "include" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load your saved account data.");
  return data;
}

function AccountDashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneOtpSent, setPhoneOtpSent] = useState(false);
  const [phoneNotice, setPhoneNotice] = useState("");
  const [library, setLibrary] = useState({
    counts: { following: 0, followers: 0, saved: 0 },
    history: [],
    meetings: [],
    favorites: [],
    watchLater: [],
    following: [],
    followers: []
  });

  useEffect(() => {
    let active = true;
    const loadAccount = async () => {
      try {
        const profileResponse = await fetch("/api/auth/me", { credentials: "include" });
        const profileData = await profileResponse.json();
        if (profileResponse.status === 401) {
          navigate("/login", { replace: true });
        }
        if (!profileResponse.ok) throw new Error(profileData.error || "Could not load your profile.");
        if (!active) return;
        setUser(profileData.user);

        const [
          dashboard,
          favorites,
          watchLater,
          following,
          followers
        ] = await Promise.all([
          fetchAccountData("/api/me/dashboard"),
          fetchAccountData("/api/me/saved-videos?collection=favorite"),
          fetchAccountData("/api/me/saved-videos?collection=watch_later"),
          fetchAccountData("/api/me/following"),
          fetchAccountData("/api/me/followers")
        ]);
        if (active) {
          setLibrary({
            ...dashboard,
            favorites: favorites.videos,
            watchLater: watchLater.videos,
            following: following.users,
            followers: followers.users
          });
        }
      } catch (error) {
        console.error("Could not load account dashboard:", error);
        if (active) setErrorMessage(error.message || "Could not load your profile.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadAccount();

    return () => {
      active = false;
    };
  }, [navigate]);

  const signOut = async () => {
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include"
      });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
      navigate("/login", { replace: true });
    } catch (error) {
      console.error("Could not sign out:", error);
      setErrorMessage(error.message || "Could not sign out. Please try again.");
    }
  };

  const linkPhone = async (event) => {
    event.preventDefault();
    const endpoint = phoneOtpSent ? "/api/auth/phone/verify" : "/api/auth/phone/request";
    const body = { phoneNumber };
    if (phoneOtpSent) body.code = phoneCode;
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { setPhoneNotice(data.error || "Could not verify your number."); return; }
      if (!phoneOtpSent) { setPhoneOtpSent(true); setPhoneNotice(data.message); return; }
      setUser(data.user);
      setPhoneNotice("Mobile number verified and linked to your account.");
    } catch (error) {
      console.error("Could not link mobile number:", error);
      setPhoneNotice("Could not reach the account service.");
    }
  };

  const continueWatching = library.history.filter((entry) =>
    entry.durationSeconds > 0 && entry.positionSeconds < entry.durationSeconds
  );
  const sections = [
    {
      icon: "↺",
      title: "Continue watching",
      description: "Your next great watch is waiting.",
      items: continueWatching.map((entry) => ({
        key: entry.videoId,
        label: entry.name,
        to: `/videos?video=${encodeURIComponent(entry.videoId)}&t=${entry.positionSeconds}`,
        detail: `${Math.floor(entry.positionSeconds)}s of ${Math.floor(entry.durationSeconds)}s watched`
      }))
    },
    {
      icon: "◷",
      title: "Recently watched",
      description: "Pick up right where you left off.",
      items: library.history.map((entry) => ({
        key: entry.videoId,
        label: entry.name,
        to: `/videos?video=${encodeURIComponent(entry.videoId)}&t=${entry.positionSeconds}`,
        detail: new Date(entry.lastWatchedAt).toLocaleDateString()
      }))
    },
    {
      icon: "♡",
      title: "Favorites",
      description: "Keep the streams you love close.",
      items: library.favorites.map((video) => ({
        key: video.id,
        label: video.name,
        to: `/videos?video=${encodeURIComponent(video.id)}`
      }))
    },
    {
      icon: "▱",
      title: "Watch later",
      description: "Save something for another time.",
      items: library.watchLater.map((video) => ({
        key: video.id,
        label: video.name,
        to: `/videos?video=${encodeURIComponent(video.id)}`
      }))
    },
    {
      icon: "＋",
      title: "Creators you follow",
      description: "Stay in the loop with your favorite streamers.",
      items: library.following.map((creator) => ({
        key: creator.id,
        label: creator.name,
        detail: `@${creator.username}`
      }))
    },
    {
      icon: "◎",
      title: "Your followers",
      description: "People who follow your streams.",
      items: library.followers.map((follower) => ({
        key: follower.id,
        label: follower.name,
        detail: `@${follower.username}`
      }))
    }
  ];

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <Link className="brand" to="/" aria-label="Streamline home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <nav aria-label="Account navigation">
          <Link to="/videos">Video library</Link>
          <button className="dashboard-signout" type="button" onClick={() => void signOut()}>Sign out</button>
        </nav>
      </header>

      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <p className="dashboard-eyebrow">YOUR STREAMING SPACE</p>
            <h1>{loading ? "Loading your profile..." : errorMessage ? "Profile unavailable" : `Welcome, ${user?.name || user?.username}`}</h1>
            <p>{errorMessage || (user ? `@${user.username} · ${user.email}` : "A little more you, everywhere.")}</p>
          </div>
          {user && <span className="dashboard-account-status">Signed in</span>}
        </div>

        <section className="dashboard-profile-card" aria-label="Profile summary">
          <div className="dashboard-avatar" aria-hidden="true">{user?.name?.charAt(0).toUpperCase() || "S"}</div>
          <div className="dashboard-profile-copy">
            <h2>{user?.name || "Your profile"}</h2>
            <p>{user ? `@${user.username} · ${user.email}` : "Account information is unavailable."}</p>
          </div>
          <div className="dashboard-profile-stats">
            <div><strong>{library.counts.following}</strong><span>Following</span></div>
            <div><strong>{library.counts.followers}</strong><span>Followers</span></div>
            <div><strong>{library.counts.saved}</strong><span>Saved</span></div>
          </div>
          <span className="dashboard-create-link">{user ? "Account active" : "Loading account"}</span>
        </section>

        <section className="dashboard-phone-card" aria-label="Mobile sign-in">
          <div>
            <h2>Mobile sign-in</h2>
            <p>{user?.phoneVerified ? `Verified: ${user.phoneNumber}` : "Add your mobile number and verify it with a one-time code."}</p>
          </div>
          {!user?.phoneVerified && <form onSubmit={linkPhone} className="dashboard-phone-form">
            <input type="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+919876543210" pattern="\+[1-9][0-9]{7,14}" required disabled={phoneOtpSent} />
            {phoneOtpSent && <input inputMode="numeric" value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} placeholder="6-digit code" maxLength={6} pattern="[0-9]{6}" required />}
            <button type="submit">{phoneOtpSent ? "Verify number" : "Send code"}</button>
            {phoneNotice && <p role="status">{phoneNotice}</p>}
          </form>}
        </section>

        <div className="dashboard-section-heading">
          <div>
            <h2>Your library</h2>
            <p>Watch history, saved videos, and creators in one place.</p>
          </div>
          <Link to="/videos">Browse videos <span aria-hidden="true">→</span></Link>
        </div>

        <section className="dashboard-grid" aria-label="Your video and creator lists">
          {sections.map((section) => (
            <article className="dashboard-feature-card" key={section.title}>
              <div className="dashboard-card-top">
                <span className="dashboard-feature-icon" aria-hidden="true">{section.icon}</span>
                <span className="dashboard-card-arrow" aria-hidden="true">↗</span>
              </div>
              <h3>{section.title}</h3>
              <p className="dashboard-card-description">{section.description}</p>
              {section.items.length ? (
                <ul className="dashboard-saved-list">
                  {section.items.slice(0, 5).map((item) => (
                    <li key={item.key}>
                      {item.to
                        ? <Link to={item.to}>{item.label}</Link>
                        : <strong>{item.label}</strong>}
                      {item.detail && <span>{item.detail}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="dashboard-empty-state">
                  <span aria-hidden="true">✦</span>
                  <p>No items yet.</p>
                </div>
              )}
            </article>
          ))}
        </section>

        <section className="dashboard-history" aria-labelledby="meeting-history-title">
          <div className="dashboard-section-heading">
            <div>
              <h2 id="meeting-history-title">Meeting history</h2>
              <p>Recent private calls linked to your account.</p>
            </div>
          </div>
          {library.meetings.length ? (
            <ul>
              {library.meetings.map((meeting) => (
                <li key={`${meeting.roomId}-${meeting.joinedAt}`}>
                  <span><strong>Private meeting</strong><time>{new Date(meeting.joinedAt).toLocaleString()}</time></span>
                  {meeting.endedAt
                    ? <span>Ended</span>
                    : <Link to={`/call/${meeting.roomId}`}>Rejoin <span aria-hidden="true">→</span></Link>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-history-empty">Your recent private meetings will appear here.</p>
          )}
        </section>

        {errorMessage && <p className="dashboard-preview-note" role="alert">{errorMessage}</p>}
      </section>

      <footer className="dashboard-footer">
        <Link to="/">← Back to Streamline</Link>
        <span>Your own space for the things you love.</span>
      </footer>
    </main>
  );
}

export default AccountDashboard;
