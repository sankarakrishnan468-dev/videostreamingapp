import { useEffect, useState } from "react";
import socket from "../services/socket";
import "./CommentThread.css";

function CommentThread({ targetType, targetId, title = "Comments" }) {
  const [comments, setComments] = useState([]);
  const [draft, setDraft] = useState("");
  const [authorName, setAuthorName] = useState(() => {
    try {
      return window.localStorage.getItem("streamline.commentName") || "";
    } catch {
      return "";
    }
  });
  const [signedIn, setSignedIn] = useState(false);
  const [replyingTo, setReplyingTo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`/api/comments?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load comments.");
        if (active) setComments(data.comments);
      })
      .catch((loadError) => {
        if (!active) return;
        console.error("Could not load comments:", loadError);
        setError(loadError.message || "Could not load comments.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    fetch("/api/auth/me", { credentials: "include" })
      .then((response) => {
        if (active) setSignedIn(response.ok);
      })
      .catch((authError) => {
        if (active) console.error("Could not check comment account:", authError);
      });

    const onLiveComment = (comment) => {
      if (comment.targetType !== targetType || comment.targetId !== targetId) return;
      setComments((current) => {
        const next = new Map(current.map((item) => [item.id, item]));
        next.set(comment.id, comment);
        return [...next.values()].sort((left, right) =>
          new Date(left.createdAt) - new Date(right.createdAt)
        );
      });
    };
    if (targetType === "live") socket.on("stream-comment", onLiveComment);

    return () => {
      active = false;
      if (targetType === "live") socket.off("stream-comment", onLiveComment);
    };
  }, [targetType, targetId]);

  const submitComment = async (event, parentId = null) => {
    event.preventDefault();
    const text = draft.trim();
    const name = authorName.trim().slice(0, 32);
    if (!text || text.length > 500 || (!signedIn && !name)) {
      setError("Enter a display name and a comment of up to 500 characters.");
      return;
    }
    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          parentId,
          authorName: name,
          text
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not post your comment.");
      setComments((current) => {
        const next = new Map(current.map((item) => [item.id, item]));
        next.set(data.comment.id, data.comment);
        return [...next.values()].sort((left, right) =>
          new Date(left.createdAt) - new Date(right.createdAt)
        );
      });
      if (!signedIn) {
        setAuthorName(name);
        try {
          window.localStorage.setItem("streamline.commentName", name);
        } catch (storageError) {
          console.warn("Could not save the comment display name:", storageError);
        }
      }
      setDraft("");
      setReplyingTo("");
      setError("");
    } catch (submitError) {
      console.error("Could not post comment:", submitError);
      setError(submitError.message || "Could not post your comment.");
    }
  };

  const roots = comments.filter((comment) => !comment.parentId);

  return (
    <section className="comment-thread" aria-label={title}>
      <header className="comment-thread-header">
        <h2>{title}</h2>
        <span>{comments.filter((comment) => !comment.parentId).length}</span>
      </header>
      {loading ? (
        <p className="comment-thread-state">Loading comments...</p>
      ) : roots.length === 0 ? (
        <p className="comment-thread-state">No comments yet. Start the conversation.</p>
      ) : (
        <ol className="comment-list">
          {roots.map((comment) => (
            <li className="comment-item" key={comment.id}>
              <article>
                <header>
                  <strong>{comment.authorName}</strong>
                  <time dateTime={comment.createdAt}>
                    {new Date(comment.createdAt).toLocaleString([], {
                      dateStyle: "short",
                      timeStyle: "short"
                    })}
                  </time>
                </header>
                <p>{comment.text}</p>
                <button
                  type="button"
                  className="comment-reply-toggle"
                  onClick={() => {
                    setReplyingTo((current) => current === comment.id ? "" : comment.id);
                    setDraft("");
                    setError("");
                  }}
                >
                  {replyingTo === comment.id ? "Cancel reply" : "Reply"}
                </button>
              </article>
              <ol className="comment-replies">
                {comments.filter((reply) => reply.parentId === comment.id).map((reply) => (
                  <li className="comment-item" key={reply.id}>
                    <article>
                      <header>
                        <strong>{reply.authorName}</strong>
                        <time dateTime={reply.createdAt}>
                          {new Date(reply.createdAt).toLocaleString([], {
                            dateStyle: "short",
                            timeStyle: "short"
                          })}
                        </time>
                      </header>
                      <p>{reply.text}</p>
                    </article>
                  </li>
                ))}
              </ol>
              {replyingTo === comment.id && (
                <form className="comment-form comment-reply-form" onSubmit={(event) => void submitComment(event, comment.id)}>
                  {!signedIn && (
                    <label>
                      Your name
                      <input
                        value={authorName}
                        maxLength={32}
                        onChange={(event) => setAuthorName(event.target.value)}
                        required
                      />
                    </label>
                  )}
                  <label>
                    Reply
                    <textarea
                      value={draft}
                      maxLength={500}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                      required
                    />
                  </label>
                  <button type="submit" disabled={!draft.trim()}>Post reply</button>
                </form>
              )}
            </li>
          ))}
        </ol>
      )}
      <form className="comment-form" onSubmit={(event) => void submitComment(event)}>
        {!signedIn && (
          <label>
            Your name
            <input
              value={authorName}
              maxLength={32}
              onChange={(event) => setAuthorName(event.target.value)}
              required
            />
          </label>
        )}
        <label>
          Add a comment
          <textarea
            value={draft}
            maxLength={500}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
            rows={3}
            required
          />
        </label>
        <div className="comment-form-footer">
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={!draft.trim()}>Post comment</button>
        </div>
      </form>
    </section>
  );
}

export default CommentThread;
