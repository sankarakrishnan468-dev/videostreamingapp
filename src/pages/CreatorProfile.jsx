import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import "./CreatorProfile.css";

function CreatorProfile() {
  const { username } = useParams();
  const navigate = useNavigate();
  const [profileResult, setProfileResult] = useState({
    username: "",
    profile: null,
    error: ""
  });
  const [currentUser, setCurrentUser] = useState(null);
  const profile = profileResult.username === username ? profileResult.profile : null;
  const error = profileResult.username === username ? profileResult.error : "";
  const loading = profileResult.username !== username;

  useEffect(() => {
    let active = true;
    fetch(`/api/creators/${encodeURIComponent(username)}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load creator profile.");
        if (active) setProfileResult({ username, profile: data, error: "" });
      })
      .catch((loadError) => {
        if (!active) return;
        console.error("Could not load creator profile:", loadError);
        setProfileResult({
          username,
          profile: null,
          error: loadError.message || "Could not load creator profile."
        });
      });
    fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) return null;
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load account details.");
        return data.user;
      })
      .then((user) => {
        if (active) setCurrentUser(user);
      })
      .catch((authError) => {
        if (active) console.error("Could not load account details:", authError);
      });
    return () => {
      active = false;
    };
  }, [username]);

  const toggleFollow = async () => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const creator = profile?.creator;
    if (!creator || creator.id === currentUser.id) return;
    try {
      const response = await fetch(`/api/me/following/${creator.id}`, {
        method: creator.isFollowing ? "DELETE" : "PUT",
        credentials: "include"
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not update your followed creators.");
      }
      setProfileResult((current) => ({
        ...current,
        error: "",
        profile: current.profile && {
          ...current.profile,
          creator: {
            ...current.profile.creator,
            isFollowing: !current.profile.creator.isFollowing,
            followerCount: Math.max(
            0,
              current.profile.creator.followerCount + (current.profile.creator.isFollowing ? -1 : 1)
            )
          }
        }
      }));
    } catch (followError) {
      console.error("Could not update followed creator:", followError);
      setProfileResult((current) => ({
        ...current,
        error: followError.message || "Could not update your followed creators."
      }));
    }
  };

  return (
    <main className="creator-profile-page">
      <header className="creator-profile-header">
        <Link className="brand" to="/">streamline</Link>
        <nav aria-label="Main navigation">
          <Link to="/">Home</Link>
          <Link to="/videos">Video library</Link>
          <Link to="/login">Sign in</Link>
        </nav>
      </header>
      <section className="creator-profile-content">
        {loading ? (
          <p role="status">Loading creator profile...</p>
        ) : error && !profile ? (
          <p className="creator-profile-error" role="alert">{error}</p>
        ) : profile ? (
          <>
            <section className="creator-profile-card">
              {profile.creator.avatarUrl && (
                <img src={profile.creator.avatarUrl} alt="" className="creator-profile-avatar" />
              )}
              <div>
                <p className="creator-profile-eyebrow">CREATOR</p>
                <h1>{profile.creator.name}</h1>
                <p className="creator-profile-username">@{profile.creator.username}</p>
                <p>{profile.creator.bio || "This creator has not added a bio yet."}</p>
                <span>{profile.creator.followerCount} followers</span>
              </div>
              {profile.creator.id !== currentUser?.id && (
                <button
                  type="button"
                  aria-pressed={profile.creator.isFollowing}
                  onClick={() => void toggleFollow()}
                >
                  {profile.creator.isFollowing ? "Following" : "Follow"}
                </button>
              )}
            </section>
            {error && <p className="creator-profile-error" role="alert">{error}</p>}
            <section className="creator-video-section">
              <h2>Videos</h2>
              {profile.videos.length === 0 ? (
                <p>No videos published yet.</p>
              ) : (
                <div className="creator-video-grid">
                  {profile.videos.map((video) => (
                    <article key={video.id}>
                      <video controls preload="metadata" poster={video.thumbnailUrl || undefined} src={video.url} />
                      <h3>{video.name}</h3>
                      <p>{video.description || video.category}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}

export default CreatorProfile;
