import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import socket from "../services/socket";
import "./LiveEngagement.css";

function LiveEngagement({ roomId }) {
  const navigate = useNavigate();
  const [engagement, setEngagement] = useState({
    live: false,
    likes: 0,
    viewerReaction: null,
    creator: null
  });
  const [currentUser, setCurrentUser] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    if (!roomId) return () => {
      active = false;
    };
    const loadEngagement = async () => {
      try {
        const response = await fetch(`/api/live/${roomId}/engagement`, { credentials: "include" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load live-stream details.");
        if (active) {
          setEngagement(data);
          setError("");
        }
      } catch (loadError) {
        if (active) {
          console.error("Could not load live-stream engagement:", loadError);
          setError(loadError.message || "Could not load live-stream details.");
        }
      }
    };
    const loadUser = async () => {
      try {
        const response = await fetch("/api/auth/me", { credentials: "include" });
        if (response.status === 401) return;
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load account details.");
        if (active) setCurrentUser(data.user);
      } catch (userError) {
        if (active) console.error("Could not load account details:", userError);
      }
    };
    const onEngagementUpdate = (update) => {
      if (update.roomId === roomId) setEngagement((current) => ({ ...current, likes: update.likes }));
    };

    void loadEngagement();
    void loadUser();
    const poll = window.setInterval(() => void loadEngagement(), 5000);
    socket.on("live-engagement-update", onEngagementUpdate);
    return () => {
      active = false;
      window.clearInterval(poll);
      socket.off("live-engagement-update", onEngagementUpdate);
    };
  }, [roomId]);

  const updateLike = async () => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const reaction = engagement.viewerReaction === "like" ? "none" : "like";
    try {
      const response = await fetch(`/api/live/${roomId}/reaction`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update your like.");
      setEngagement((current) => ({ ...current, ...data }));
      setError("");
    } catch (likeError) {
      console.error("Could not update live-stream reaction:", likeError);
      setError(likeError.message || "Could not update your like.");
    }
  };

  const toggleFollow = async () => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const creator = engagement.creator;
    if (!creator) return;
    try {
      const response = await fetch(`/api/me/following/${creator.id}`, {
        method: creator.isFollowing ? "DELETE" : "PUT",
        credentials: "include"
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not update your followed creators.");
      }
      setEngagement((current) => ({
        ...current,
        creator: {
          ...current.creator,
          isFollowing: !current.creator.isFollowing,
          followerCount: Math.max(
            0,
            current.creator.followerCount + (current.creator.isFollowing ? -1 : 1)
          )
        }
      }));
      setError("");
    } catch (followError) {
      console.error("Could not update followed creator:", followError);
      setError(followError.message || "Could not update your followed creators.");
    }
  };

  const shareLive = async () => {
    const url = new URL(`/viewer/${roomId}`, window.location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Live stream", url });
      } else {
        await navigator.clipboard.writeText(url);
        setError("");
      }
    } catch (shareError) {
      if (shareError.name !== "AbortError") {
        console.error("Could not share live stream:", shareError);
        setError("Could not share the link. Copy the viewer link from your browser.");
      }
    }
  };

  return (
    <section className="live-engagement" aria-label="Live stream engagement">
      {roomId && <div className="live-engagement-actions">
        <button
          type="button"
          aria-pressed={engagement.viewerReaction === "like"}
          onClick={() => void updateLike()}
        >
          {engagement.viewerReaction === "like" ? "Liked" : "Like"} · {engagement.likes}
        </button>
        <button type="button" onClick={() => void shareLive()}>Share stream</button>
      </div>}
      {engagement.creator && (
        <div className="live-creator-card">
          <div>
            <strong>{engagement.creator.name}</strong>
            <span>@{engagement.creator.username} · {engagement.creator.followerCount} followers</span>
          </div>
          <Link to={`/creators/${engagement.creator.username}`}>Profile</Link>
          {engagement.creator.id !== currentUser?.id && (
            <button type="button" onClick={() => void toggleFollow()}>
              {engagement.creator.isFollowing ? "Following" : "Follow"}
            </button>
          )}
        </div>
      )}
      {!roomId && <p className="live-engagement-note">Stream details are not available yet.</p>}
      {roomId && !engagement.live && <p className="live-engagement-note">This stream has ended.</p>}
      {error && <p className="live-engagement-error" role="alert">{error}</p>}
    </section>
  );
}

export default LiveEngagement;
