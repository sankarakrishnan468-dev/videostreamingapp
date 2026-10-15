import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import CommentThread from "../components/CommentThread.jsx";
import "./Videos.css";

const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

function formatFileSize(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function persistWatchProgress(userId, videoId, positionSeconds, durationSeconds, progressTimes, setError, force = false) {
  if (!userId || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
  const now = Date.now();
  if (!force && now - (progressTimes.get(videoId) || 0) < 15_000) return;
  progressTimes.set(videoId, now);
  fetch("/api/me/watch-history", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, positionSeconds, durationSeconds })
  }).then(async (response) => {
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Could not save your watch progress.");
    }
  }).catch((saveError) => {
    console.error("Could not save playback progress:", saveError);
    setError(saveError.message || "Could not save your watch progress.");
  });
}

function Videos() {
  const uploadFormRef = useRef(null);
  const videoElementsRef = useRef(new Map());
  const lastProgressRef = useRef(new Map());
  const resumeAttemptedRef = useRef(new Set());
  const qualitySeekRef = useRef(new Map());
  const location = useLocation();
  const navigate = useNavigate();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [savedVideos, setSavedVideos] = useState(new Set());
  const [followedCreators, setFollowedCreators] = useState(new Set());
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [playbackRates, setPlaybackRates] = useState({});
  const [qualities, setQualities] = useState({});
  const [reportingVideoId, setReportingVideoId] = useState("");
  const [commentsVideoId, setCommentsVideoId] = useState("");
  const [reportReason, setReportReason] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetch("/api/videos")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load videos.");
        return data.videos;
      })
      .then((library) => {
        if (active) setVideos(library);
      })
      .catch((loadError) => {
        if (!active) return;
        console.error("Could not load the video library:", loadError);
        setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    fetch("/api/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) return null;
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load your account.");
        return data.user;
      })
      .then(async (user) => {
        if (!active || !user) return;
        setCurrentUser(user);
        const [favoritesResponse, watchLaterResponse, followingResponse] = await Promise.all([
          fetch("/api/me/saved-videos?collection=favorite", { credentials: "include" }),
          fetch("/api/me/saved-videos?collection=watch_later", { credentials: "include" }),
          fetch("/api/me/following", { credentials: "include" })
        ]);
        const [favorites, watchLater, following] = await Promise.all([
          favoritesResponse.json(),
          watchLaterResponse.json(),
          followingResponse.json()
        ]);
        const failedResponse = [favoritesResponse, watchLaterResponse, followingResponse]
          .find((response) => !response.ok);
        if (failedResponse) {
          const failedData = [favorites, watchLater, following][
            [favoritesResponse, watchLaterResponse, followingResponse].indexOf(failedResponse)
          ];
          throw new Error(failedData.error || "Could not load your saved lists.");
        }
        if (active) {
          setSavedVideos(new Set([
            ...favorites.videos.map((video) => `favorite:${video.id}`),
            ...watchLater.videos.map((video) => `watch_later:${video.id}`)
          ]));
          setFollowedCreators(new Set(following.users.map((creator) => creator.id)));
        }
      })
      .catch((accountError) => {
        if (!active) return;
        console.error("Could not load saved account lists:", accountError);
        setError(accountError.message || "Could not load your saved account lists.");
      });

    return () => {
      active = false;
    };
  }, []);

  const toggleSavedVideo = async (video, collection) => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const key = `${collection}:${video.id}`;
    const isSaved = savedVideos.has(key);
    try {
      const response = await fetch(`/api/me/saved-videos/${video.id}${isSaved ? `?collection=${collection}` : ""}`, {
        method: isSaved ? "DELETE" : "PUT",
        credentials: "include",
        headers: isSaved ? undefined : { "Content-Type": "application/json" },
        body: isSaved ? undefined : JSON.stringify({ collection })
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not update your saved videos.");
      }
      setSavedVideos((previous) => {
        const next = new Set(previous);
        if (isSaved) next.delete(key);
        else next.add(key);
        return next;
      });
      setMessage(isSaved ? "Removed from your saved videos." : "Added to your saved videos.");
      setError("");
    } catch (saveError) {
      console.error("Could not update saved video:", saveError);
      setError(saveError.message || "Could not update your saved videos.");
    }
  };

  const toggleFollow = async (creator) => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const isFollowing = followedCreators.has(creator.id);
    try {
      const response = await fetch(`/api/me/following/${creator.id}`, {
        method: isFollowing ? "DELETE" : "PUT",
        credentials: "include"
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not update your followed creators.");
      }
      setFollowedCreators((previous) => {
        const next = new Set(previous);
        if (isFollowing) next.delete(creator.id);
        else next.add(creator.id);
        return next;
      });
      setError("");
    } catch (followError) {
      console.error("Could not update followed creator:", followError);
      setError(followError.message || "Could not update your followed creators.");
    }
  };

  const uploadVideo = async (event) => {
    event.preventDefault();
    const form = uploadFormRef.current;
    const file = form?.elements.namedItem("video")?.files?.[0];
    if (!file) {
      setError("Choose a video file to upload.");
      return;
    }

    setError("");
    setMessage("");

    if (!file.type.startsWith("video/")) {
      setError("Choose a video file, such as MP4 or WebM.");
      return;
    }

    if (file.size > MAX_VIDEO_SIZE) {
      setError("The video is larger than the 1 GB upload limit.");
      return;
    }

    const formData = new FormData();
    formData.append("video", file);
    const title = form.elements.title.value.trim();
    const description = form.elements.description.value.trim();
    const category = form.elements.category.value.trim() || "Other";
    const tags = form.elements.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!title || title.length > 160 || description.length > 2000 || category.length > 60 || tags.length > 20 || tags.some((tag) => tag.length > 40)) {
      setError("Enter a title and keep the description, category, and up to 20 tags within their limits.");
      return;
    }
    formData.append("title", title);
    formData.append("description", description);
    formData.append("category", category);
    formData.append("tags", JSON.stringify(tags));
    const thumbnail = form.elements.namedItem("thumbnail")?.files?.[0];
    const captions = form.elements.namedItem("captions")?.files?.[0];
    if (thumbnail) formData.append("thumbnail", thumbnail);
    if (captions) formData.append("captions", captions);
    for (const quality of ["360p", "480p", "720p", "1080p"]) {
      const variant = form.elements.namedItem(`variant_${quality}`)?.files?.[0];
      if (variant) formData.append(`variant_${quality}`, variant);
    }
    setUploading(true);

    try {
      const response = await fetch("/api/videos", {
        method: "POST",
        body: formData
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The video upload failed.");

      setVideos((currentVideos) => [data.video, ...currentVideos]);
      setMessage(`“${data.video.name}” was uploaded and is ready to play.`);
      form.reset();
      setShowUploadForm(false);
    } catch (uploadError) {
      console.error("Could not upload video:", uploadError);
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  };

  const updateReaction = async (video, reaction) => {
    if (!currentUser) {
      navigate("/login");
      return;
    }
    const nextReaction = video.viewerReaction === reaction ? "none" : reaction;
    try {
      const response = await fetch(`/api/videos/${video.id}/reaction`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction: nextReaction })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update your reaction.");
      setVideos((current) => current.map((item) => item.id === video.id ? { ...item, ...data } : item));
      setError("");
    } catch (reactionError) {
      console.error("Could not update video reaction:", reactionError);
      setError(reactionError.message || "Could not update your reaction.");
    }
  };

  const shareVideo = async (video) => {
    const player = videoElementsRef.current.get(video.id);
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("video", video.id);
    if (player && Number.isFinite(player.currentTime) && player.currentTime > 0) {
      shareUrl.searchParams.set("t", String(Math.floor(player.currentTime)));
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: video.name, text: video.description, url: shareUrl.href });
      } else {
        await navigator.clipboard.writeText(shareUrl.href);
        setMessage("Video link copied.");
      }
    } catch (shareError) {
      if (shareError.name !== "AbortError") {
        console.error("Could not share video:", shareError);
        setError("Could not share the link. Copy it from the address bar instead.");
      }
    }
  };

  const submitReport = async (event, video) => {
    event.preventDefault();
    if (!currentUser) {
      navigate("/login");
      return;
    }
    try {
      const response = await fetch(`/api/videos/${video.id}/report`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reportReason, details: reportDetails })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not submit the report.");
      setMessage(data.message);
      setReportingVideoId("");
      setReportDetails("");
      setError("");
    } catch (reportError) {
      console.error("Could not submit video report:", reportError);
      setError(reportError.message || "Could not submit the report.");
    }
  };

  const handlePlaybackMetadata = async (event, video) => {
    const player = event.currentTarget;
    player.playbackRate = playbackRates[video.id] || 1;
    const pendingQualitySeek = qualitySeekRef.current.get(video.id);
    if (pendingQualitySeek) {
      qualitySeekRef.current.delete(video.id);
      player.currentTime = Math.min(pendingQualitySeek.position, player.duration || pendingQualitySeek.position);
      if (!pendingQualitySeek.paused) player.play().catch((playError) => {
        console.warn("Could not resume after changing video quality:", playError);
      });
    } else if (!resumeAttemptedRef.current.has(video.id)) {
      resumeAttemptedRef.current.add(video.id);
      const search = new URLSearchParams(location.search);
      const sharedVideo = search.get("video") === video.id;
      const sharedPosition = Number(search.get("t"));
      if (sharedVideo && Number.isFinite(sharedPosition) && sharedPosition > 0) {
        player.currentTime = Math.min(sharedPosition, player.duration);
      } else {
        try {
          const response = await fetch(`/api/me/watch-history/${video.id}`, { credentials: "include" });
          if (response.status !== 401) {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Could not load your playback progress.");
            if (data.positionSeconds > 3 && data.positionSeconds < player.duration - 10) {
              player.currentTime = data.positionSeconds;
            }
          }
        } catch (resumeError) {
          console.error("Could not resume video playback:", resumeError);
          setError(resumeError.message || "Could not load your playback progress.");
        }
      }
    }
    if (new URLSearchParams(location.search).get("video") === video.id) {
      player.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const changeQuality = (video, event) => {
    const player = videoElementsRef.current.get(video.id);
    if (player && Number.isFinite(player.duration) && player.duration > 0) {
      qualitySeekRef.current.set(video.id, { position: player.currentTime, paused: player.paused });
    }
    setQualities((current) => ({ ...current, [video.id]: event.target.value }));
  };

  const togglePictureInPicture = async (video) => {
    const player = videoElementsRef.current.get(video.id);
    if (!player || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement === player) await document.exitPictureInPicture();
      else await player.requestPictureInPicture();
    } catch (pictureError) {
      console.error("Could not toggle picture-in-picture:", pictureError);
      setError("Picture-in-picture is unavailable for this video.");
    }
  };

  const categories = [...new Set(videos.map((video) => video.category || "Other"))].sort();
  const visibleVideos = selectedCategory === "All"
    ? videos
    : videos.filter((video) => (video.category || "Other") === selectedCategory);

  return (
    <main className="videos-page">
      <header className="videos-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <Link className="videos-back-link" to="/">Back home</Link>
      </header>

      <section className="videos-main">
        <div className="videos-title-row">
          <div>
            <p className="videos-eyebrow">YOUR VIDEO SPACE</p>
            <h1>Video library</h1>
            <p className="videos-intro">Upload your videos and play them right here.</p>
          </div>
          <button
            className="upload-video-button"
            type="button"
            onClick={() => setShowUploadForm((shown) => !shown)}
            disabled={uploading}
          >
            {uploading ? "Uploading..." : showUploadForm ? "Cancel upload" : "Upload a video"}
          </button>
        </div>

        <p className="upload-hint">MP4, WebM, OGG, MOV, or M4V · up to 1 GB per video</p>

        {showUploadForm && (
          <form className="video-upload-form" ref={uploadFormRef} onSubmit={uploadVideo}>
            <label>
              Video file
              <input
                name="video"
                type="file"
                required
                accept="video/mp4,video/webm,video/ogg,video/quicktime,video/x-m4v"
              />
            </label>
            <label>
              Title
              <input name="title" type="text" required maxLength={160} placeholder="Video title" />
            </label>
            <label>
              Description
              <textarea name="description" maxLength={2000} rows={3} placeholder="Describe your video" />
            </label>
            <label>
              Category
              <input name="category" type="text" maxLength={60} list="video-categories" placeholder="Other" />
              <datalist id="video-categories">
                {categories.map((category) => <option key={category} value={category} />)}
              </datalist>
            </label>
            <label>
              Tags
              <input name="tags" type="text" placeholder="Separate up to 20 tags with commas" />
            </label>
            <label>
              Thumbnail (JPG, PNG, WebP)
              <input name="thumbnail" type="file" accept="image/jpeg,image/png,image/webp" />
            </label>
            <label>
              Captions (WebVTT .vtt)
              <input name="captions" type="file" accept=".vtt,text/vtt" />
            </label>
            <fieldset className="video-quality-uploads">
              <legend>Optional alternate quality files</legend>
              <p>Upload matching encodes to let viewers switch quality. These files are not transcoded automatically.</p>
              {["360p", "480p", "720p", "1080p"].map((quality) => (
                <label key={quality}>
                  {quality}
                  <input
                    name={`variant_${quality}`}
                    type="file"
                    accept="video/mp4,video/webm,video/ogg,video/quicktime,video/x-m4v"
                  />
                </label>
              ))}
            </fieldset>
            <button className="upload-video-button" type="submit" disabled={uploading}>
              {uploading ? "Uploading..." : "Upload video"}
            </button>
          </form>
        )}

        {videos.length > 0 && (
          <label className="video-category-filter">
            Category
            <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
              <option value="All">All categories</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
        )}

        {message && <p className="video-feedback" role="status">{message}</p>}
        {error && <p className="video-error" role="alert">{error}</p>}

        {loading ? (
          <p className="video-empty-state">Loading your video library...</p>
        ) : videos.length === 0 ? (
          <div className="video-empty-state">
            <span className="empty-video-icon" aria-hidden="true">▶</span>
            <h2>No videos yet</h2>
            <p>Choose “Upload a video” to add the first one to your library.</p>
          </div>
        ) : (
          visibleVideos.length === 0 ? (
            <p className="video-empty-state">No videos in this category yet.</p>
          ) : (
          <section className="video-library-grid" aria-label="Uploaded videos">
            {visibleVideos.map((video) => {
              const selectedQuality = qualities[video.id] || "original";
              const selectedVariant = video.variants?.find((variant) => variant.quality === selectedQuality);
              return (
              <article className="library-video-card" id={`video-${video.id}`} key={video.id}>
                <video
                  controls
                  preload="metadata"
                  playsInline
                  aria-label={`Play ${video.name}`}
                  poster={video.thumbnailUrl || undefined}
                  src={selectedVariant?.url || video.url}
                  ref={(element) => {
                    if (element) videoElementsRef.current.set(video.id, element);
                    else videoElementsRef.current.delete(video.id);
                  }}
                  onLoadedMetadata={(event) => void handlePlaybackMetadata(event, video)}
                  onPause={(event) => persistWatchProgress(
                    currentUser?.id,
                    video.id,
                    event.currentTarget.currentTime,
                    event.currentTarget.duration,
                    lastProgressRef.current,
                    setError,
                    true
                  )}
                  onTimeUpdate={(event) => persistWatchProgress(
                    currentUser?.id,
                    video.id,
                    event.currentTarget.currentTime,
                    event.currentTarget.duration,
                    lastProgressRef.current,
                    setError
                  )}
                  onEnded={(event) => persistWatchProgress(
                    currentUser?.id,
                    video.id,
                    event.currentTarget.duration,
                    event.currentTarget.duration,
                    lastProgressRef.current,
                    setError,
                    true
                  )}
                >
                  {video.captionsUrl && (
                    <track kind="captions" src={video.captionsUrl} srcLang="en" label="Captions" />
                  )}
                  Your browser cannot play this video format.
                </video>
                <div className="library-video-details">
                  <div>
                    <h2 title={video.name}>{video.name}</h2>
                    <p className="library-video-description">{video.description || "No description provided."}</p>
                    <span className="library-video-category">{video.category || "Other"}</span>
                    {video.tags?.length > 0 && (
                      <ul className="library-video-tags">
                        {video.tags.map((tag) => <li key={tag}>{tag}</li>)}
                      </ul>
                    )}
                  </div>
                  <span>{formatFileSize(video.size)}</span>
                </div>
                <div className="video-player-options">
                  <label>
                    Speed
                    <select
                      value={playbackRates[video.id] || 1}
                      onChange={(event) => {
                        const rate = Number(event.target.value);
                        const player = videoElementsRef.current.get(video.id);
                        if (player) player.playbackRate = rate;
                        setPlaybackRates((current) => ({ ...current, [video.id]: rate }));
                      }}
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                        <option key={rate} value={rate}>{rate === 1 ? "Normal" : `${rate}×`}</option>
                      ))}
                    </select>
                  </label>
                  {video.variants?.length > 0 && (
                    <label>
                      Quality
                      <select value={selectedQuality} onChange={(event) => changeQuality(video, event)}>
                        <option value="original">Original</option>
                        {video.variants.map((variant) => (
                          <option key={variant.quality} value={variant.quality}>{variant.quality}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {document.pictureInPictureEnabled && (
                    <button type="button" onClick={() => void togglePictureInPicture(video)}>Picture-in-picture</button>
                  )}
                </div>
                <div className="library-video-actions">
                  <button
                    type="button"
                    aria-pressed={video.viewerReaction === "like"}
                    onClick={() => void updateReaction(video, "like")}
                  >
                    Like {video.likes || 0}
                  </button>
                  <button
                    type="button"
                    aria-pressed={video.viewerReaction === "dislike"}
                    onClick={() => void updateReaction(video, "dislike")}
                  >
                    Dislike {video.dislikes || 0}
                  </button>
                  <button
                    type="button"
                    aria-pressed={savedVideos.has(`favorite:${video.id}`)}
                    onClick={() => void toggleSavedVideo(video, "favorite")}
                  >
                    {savedVideos.has(`favorite:${video.id}`) ? "Favorited" : "Favorite"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={savedVideos.has(`watch_later:${video.id}`)}
                    onClick={() => void toggleSavedVideo(video, "watch_later")}
                  >
                    {savedVideos.has(`watch_later:${video.id}`) ? "Saved for later" : "Watch later"}
                  </button>
                  <button
                    type="button"
                    aria-expanded={commentsVideoId === video.id}
                    onClick={() => setCommentsVideoId((current) => current === video.id ? "" : video.id)}
                  >
                    {commentsVideoId === video.id ? "Hide comments" : "Comments"}
                  </button>
                  <button type="button" onClick={() => void shareVideo(video)}>Share</button>
                  <a href={`${video.url}?download=1`} download>Download</a>
                  <button
                    type="button"
                    onClick={() => {
                      setReportingVideoId((current) => current === video.id ? "" : video.id);
                      setReportReason("spam");
                      setReportDetails("");
                    }}
                  >
                    Report
                  </button>
                  {reportingVideoId === video.id && (
                    <form className="video-report-form" onSubmit={(event) => void submitReport(event, video)}>
                      <label>
                        Reason
                        <select value={reportReason} onChange={(event) => setReportReason(event.target.value)}>
                          <option value="spam">Spam</option>
                          <option value="harassment">Harassment</option>
                          <option value="violence">Violence or dangerous content</option>
                          <option value="misinformation">Misinformation</option>
                          <option value="copyright">Copyright concern</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                      <label>
                        Details (optional)
                        <textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} maxLength={1000} rows={2} />
                      </label>
                      <button type="submit">Submit report</button>
                    </form>
                  )}
                  {video.creator && (
                    <div className="library-video-creator">
                      <Link to={`/creators/${video.creator.username}`}>
                        {video.creator.name} · @{video.creator.username}
                      </Link>
                      {video.creator.id !== currentUser?.id && (
                        <button
                          type="button"
                          aria-pressed={followedCreators.has(video.creator.id)}
                          onClick={() => void toggleFollow(video.creator)}
                        >
                          {followedCreators.has(video.creator.id) ? "Following" : "Follow"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {commentsVideoId === video.id && (
                  <CommentThread targetType="video" targetId={video.id} />
                )}
              </article>
            );})}
          </section>
          )
        )}
      </section>
    </main>
  );
}

export default Videos;
