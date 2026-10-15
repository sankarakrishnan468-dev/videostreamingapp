const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const http = require("http");
const cors = require("cors");
const fs = require("fs");
const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} = require("crypto");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const { authRouter, authenticate, optionalAuthenticate, getSocketUser } = require("./auth");
const {
  connectDatabase,
  User,
  Video,
  VideoReaction,
  Comment,
  LiveReaction,
  LiveStream,
  LiveSession,
  LiveViewerSession,
  LiveChatMessage,
  VideoReport,
  Follow,
  WatchHistory,
  SavedVideo,
  Meeting,
  MeetingParticipant,
  mongoose
} = require("./database");

const MAX_GROUP_PARTICIPANTS = 4;
const MAX_COMMENT_LENGTH = 500;
const LIVE_HEARTBEAT_TTL_MS = 60_000;

const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogg", ".mov", ".m4v"]);
const VIDEO_QUALITIES = ["360p", "480p", "720p", "1080p"];
const CAPTION_EXTENSION = ".vtt";
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const uploadDirectory = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDirectory, { recursive: true });
const groupRoomSettings = new Map();

const app = express();
const frontendOrigins = (
  process.env.FRONTEND_ORIGINS
    || "http://localhost:5173,http://127.0.0.1:5173,https://slot-shadily-regress.ngrok-free.dev"
).split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(cors({
  origin: frontendOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"]
}));

app.use(express.json());
app.use("/api/auth", authRouter);

const iceCredentialRequests = new Map();
const commentRequestsByIp = new Map();

app.get("/api/ice-servers", (req, res) => {
  const now = Date.now();
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const requests = (iceCredentialRequests.get(clientIp) || [])
    .filter((timestamp) => now - timestamp < 60_000);
  if (requests.length >= 30) {
    res.set("Retry-After", "60");
    res.status(429).json({ error: "Network configuration requested too frequently." });
    return;
  }
  requests.push(now);
  iceCredentialRequests.set(clientIp, requests);

  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const sharedSecret = process.env.TURN_SHARED_SECRET;
  const turnConfigured = urls.length > 0 && Boolean(sharedSecret);
  if ((urls.length > 0) !== Boolean(sharedSecret)) {
    res.status(503).json({
      error: "TURN_URLS and TURN_SHARED_SECRET must both be configured."
    });
    return;
  }
  if (urls.some((url) => !/^turns?:/i.test(url))) {
    res.status(503).json({ error: "TURN_URLS must contain valid turn: or turns: URLs." });
    return;
  }

  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (turnConfigured) {
    const expiresAt = Math.floor(now / 1000) + 3600;
    const username = `${expiresAt}:streamline`;
    const credential = createHmac("sha1", sharedSecret)
      .update(username)
      .digest("base64");
    iceServers.push({ urls, username, credential });
  }

  res.set("Cache-Control", "no-store");
  res.json({ iceServers, turnConfigured });
});

app.post("/api/calls", optionalAuthenticate, async (req, res) => {
  const password = req.body?.password;
  if (
    password !== undefined &&
    (typeof password !== "string" || (password && (password.length < 6 || Buffer.byteLength(password, "utf8") > 72)))
  ) {
    res.status(400).json({ error: "Meeting passwords must be 6–72 UTF-8 bytes." });
    return;
  }

  try {
    const roomId = randomBytes(16).toString("hex");
    const hostKey = randomBytes(32).toString("hex");
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const hostKeyHash = createHash("sha256").update(hostKey).digest("hex");
    await Meeting.create({
      _id: roomId,
      hostUserId: req.user?.id || null,
      passwordHash,
      hostKeyHash,
      startedAt: new Date()
    });
    groupRoomSettings.set(`group-call:${roomId}`, {
      passwordHash,
      hostKeyHash,
      hostId: null,
      hostEstablished: false,
      waitingParticipants: new Set(),
      mutedParticipants: new Set()
    });
    res.status(201).json({ roomId, hostKey });
  } catch (error) {
    console.error("Could not create private call room:", error);
    res.status(500).json({ error: "Could not create a private call room." });
  }
});

app.get("/api/me/followers", authenticate, async (req, res) => {
  try {
    const follows = await Follow.find({ followedId: req.user.id })
      .sort({ createdAt: -1 })
      .populate("followerId", "username name avatarUrl bio");
    res.json({
      users: follows.filter((follow) => follow.followerId).map((follow) => ({
        id: follow.followerId._id,
        username: follow.followerId.username,
        name: follow.followerId.name,
        avatarUrl: follow.followerId.avatarUrl,
        bio: follow.followerId.bio
      }))
    });
  } catch (error) {
    console.error("Could not load followers:", error);
    res.status(500).json({ error: "Could not load your followers." });
  }
});

app.get("/api/me/dashboard", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const [followingCount, followerCount, savedCount, history, meetings] = await Promise.all([
      Follow.countDocuments({ followerId: userId }),
      Follow.countDocuments({ followedId: userId }),
      SavedVideo.countDocuments({ userId }),
      WatchHistory.find({ userId }).sort({ lastWatchedAt: -1 }).limit(10)
        .populate("videoId", "name mimetype"),
      MeetingParticipant.find({ userId }).sort({ joinedAt: -1 }).limit(20)
        .populate("roomId", "startedAt endedAt")
    ]);

    res.json({
      counts: { following: followingCount, followers: followerCount, saved: savedCount },
      history: history.filter((entry) => entry.videoId).map((entry) => ({
        videoId: entry.videoId._id,
        name: entry.videoId.name,
        positionSeconds: entry.positionSeconds,
        durationSeconds: entry.durationSeconds,
        lastWatchedAt: entry.lastWatchedAt
      })),
      meetings: meetings.filter((entry) => entry.roomId).map((entry) => ({
        roomId: entry.roomId._id,
        joinedAt: entry.joinedAt,
        endedAt: entry.roomId.endedAt
      }))
    });
  } catch (error) {
    console.error("Could not load account dashboard data:", error);
    res.status(500).json({ error: "Could not load your saved account data." });
  }
});

app.post("/api/me/watch-history", authenticate, async (req, res) => {
  const { videoId, positionSeconds, durationSeconds } = req.body || {};
  if (
    typeof videoId !== "string" ||
    !/^[a-f\d-]{36}$/i.test(videoId) ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0
  ) {
    res.status(400).json({ error: "Video ID and valid playback position are required." });
    return;
  }

  try {
    const videoExists = await Video.exists({ _id: videoId });
    if (!videoExists) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    await WatchHistory.findOneAndUpdate(
      { userId: req.user.id, videoId },
      {
        $set: {
          positionSeconds: Math.min(positionSeconds, durationSeconds || positionSeconds),
          durationSeconds,
          lastWatchedAt: new Date()
        }
      },
      { upsert: true, new: true, runValidators: true }
    );
    res.status(204).end();
  } catch (error) {
    console.error("Could not save video watch progress:", error);
    res.status(500).json({ error: "Could not save your watch progress." });
  }
});

app.get("/api/me/watch-history/:videoId", authenticate, async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-f\d-]{36}$/i.test(videoId)) {
    res.status(400).json({ error: "Choose a valid video." });
    return;
  }
  try {
    const history = await WatchHistory.findOne({ userId: req.user.id, videoId })
      .select("positionSeconds durationSeconds");
    res.json({
      positionSeconds: history?.positionSeconds || 0,
      durationSeconds: history?.durationSeconds || 0
    });
  } catch (error) {
    console.error("Could not load video watch progress:", error);
    res.status(500).json({ error: "Could not load your playback progress." });
  }
});

app.get("/api/me/saved-videos", authenticate, async (req, res) => {
  const collection = req.query.collection;
  if (!["favorite", "watch_later"].includes(collection)) {
    res.status(400).json({ error: "Choose the favorite or watch_later collection." });
    return;
  }
  try {
    const saved = await SavedVideo.find({ userId: req.user.id, listType: collection })
      .sort({ createdAt: -1 })
      .populate("videoId", "name mimetype fileName sizeBytes uploadedAt");
    res.json({
      videos: saved.filter((entry) => entry.videoId).map((entry) => ({
        id: entry.videoId._id,
        name: entry.videoId.name,
        mimetype: entry.videoId.mimetype,
        size: entry.videoId.sizeBytes,
        uploadedAt: entry.videoId.uploadedAt,
        url: `/api/videos/${entry.videoId._id}`
      }))
    });
  } catch (error) {
    console.error("Could not load saved videos:", error);
    res.status(500).json({ error: "Could not load your saved videos." });
  }
});

app.put("/api/me/saved-videos/:videoId", authenticate, async (req, res) => {
  const { videoId } = req.params;
  const collection = req.body?.collection;
  if (
    !/^[a-f\d-]{36}$/i.test(videoId) ||
    !["favorite", "watch_later"].includes(collection)
  ) {
    res.status(400).json({ error: "Choose a valid video and saved collection." });
    return;
  }
  try {
    if (!await Video.exists({ _id: videoId })) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    await SavedVideo.updateOne(
      { userId: req.user.id, videoId, listType: collection },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.status(204).end();
  } catch (error) {
    console.error("Could not save video to your library:", error);
    res.status(500).json({ error: "Could not save this video." });
  }
});

app.delete("/api/me/saved-videos/:videoId", authenticate, async (req, res) => {
  const { videoId } = req.params;
  const collection = req.query.collection;
  if (
    !/^[a-f\d-]{36}$/i.test(videoId) ||
    !["favorite", "watch_later"].includes(collection)
  ) {
    res.status(400).json({ error: "Choose a valid video and saved collection." });
    return;
  }
  try {
    await SavedVideo.deleteOne({ userId: req.user.id, videoId, listType: collection });
    res.status(204).end();
  } catch (error) {
    console.error("Could not remove saved video:", error);
    res.status(500).json({ error: "Could not remove this saved video." });
  }
});

app.get("/api/me/following", authenticate, async (req, res) => {
  try {
    const follows = await Follow.find({ followerId: req.user.id })
      .sort({ createdAt: -1 })
      .populate("followedId", "username name avatarUrl bio");
    res.json({
      users: follows.filter((follow) => follow.followedId).map((follow) => ({
        id: follow.followedId._id,
        username: follow.followedId.username,
        name: follow.followedId.name,
        avatarUrl: follow.followedId.avatarUrl,
        bio: follow.followedId.bio
      }))
    });
  } catch (error) {
    console.error("Could not load followed creators:", error);
    res.status(500).json({ error: "Could not load followed creators." });
  }
});

app.put("/api/me/following/:userId", authenticate, async (req, res) => {
  const followedId = req.params.userId;
  if (!/^[a-f\d-]{36}$/i.test(followedId) || followedId === req.user.id) {
    res.status(400).json({ error: "You cannot follow this account." });
    return;
  }
  try {
    if (!await User.exists({ _id: followedId })) {
      res.status(404).json({ error: "Creator not found." });
      return;
    }
    await Follow.updateOne(
      { followerId: req.user.id, followedId },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    res.status(204).end();
  } catch (error) {
    console.error("Could not follow creator:", error);
    res.status(500).json({ error: "Could not follow this creator." });
  }
});

app.delete("/api/me/following/:userId", authenticate, async (req, res) => {
  try {
    await Follow.deleteOne({ followerId: req.user.id, followedId: req.params.userId });
    res.status(204).end();
  } catch (error) {
    console.error("Could not unfollow creator:", error);
    res.status(500).json({ error: "Could not unfollow this creator." });
  }
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: frontendOrigins,
    methods: ["GET", "POST"]
  }
});

io.use((socket, next) => {
  getSocketUser(socket.handshake.headers.cookie)
    .then((user) => {
      socket.data.user = user;
      next();
    })
    .catch((error) => {
      console.error("Could not authenticate socket connection:", error);
      next(new Error("Could not verify the account session."));
    });
});

function isValidCommentTarget(targetType, targetId) {
  if (targetType === "video") return /^[a-f\d-]{36}$/i.test(targetId);
  return targetType === "live" && /^[a-z\d-]{1,80}$/i.test(targetId);
}

function serializeComment(comment) {
  return {
    id: comment._id.toString(),
    targetType: comment.targetType,
    targetId: comment.targetId,
    parentId: comment.parentId ? comment.parentId.toString() : null,
    userId: comment.userId,
    authorName: comment.authorName,
    text: comment.text,
    createdAt: comment.createdAt
  };
}

app.get("/api/comments", optionalAuthenticate, async (req, res) => {
  const { targetType, targetId } = req.query;
  if (typeof targetType !== "string" || typeof targetId !== "string" ||
      !isValidCommentTarget(targetType, targetId)) {
    res.status(400).json({ error: "Choose a valid video or live-stream comment thread." });
    return;
  }
  try {
    if (targetType === "video" && !await Video.exists({ _id: targetId })) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    const CommentModel = targetType === "live" ? LiveChatMessage : Comment;
    const comments = await CommentModel.find({ targetType, targetId })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ comments: comments.reverse().map(serializeComment) });
  } catch (error) {
    console.error("Could not load comments:", error);
    res.status(500).json({ error: "Could not load comments for this content." });
  }
});

app.post("/api/comments", optionalAuthenticate, async (req, res) => {
  const { targetType, targetId, parentId } = req.body || {};
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const requestedName = typeof req.body?.authorName === "string"
    ? req.body.authorName.trim().slice(0, 32)
    : "";
  if (
    typeof targetType !== "string" ||
    typeof targetId !== "string" ||
    !isValidCommentTarget(targetType, targetId) ||
    !text ||
    text.length > MAX_COMMENT_LENGTH ||
    (parentId != null && (typeof parentId !== "string" || !/^[a-f\d]{24}$/i.test(parentId)))
  ) {
    res.status(400).json({ error: `Enter a comment of 1–${MAX_COMMENT_LENGTH} characters for valid content.` });
    return;
  }
  if (!req.user && !requestedName) {
    res.status(400).json({ error: "Enter a display name to post a comment." });
    return;
  }
  const now = Date.now();
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const recentComments = (commentRequestsByIp.get(clientIp) || [])
    .filter((timestamp) => now - timestamp < 10_000);
  if (recentComments.length >= 10) {
    res.set("Retry-After", "10");
    res.status(429).json({ error: "You are posting comments too quickly." });
    return;
  }
  recentComments.push(now);
  commentRequestsByIp.set(clientIp, recentComments);
  try {
    if (targetType === "video" && !await Video.exists({ _id: targetId })) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    if (parentId) {
      const parent = await Comment.findById(parentId).select("targetType targetId parentId");
      if (!parent || parent.targetType !== targetType || parent.targetId !== targetId || parent.parentId) {
        res.status(400).json({ error: "Replies must belong to a top-level comment in this thread." });
        return;
      }
    }
    const CommentModel = targetType === "live" ? LiveChatMessage : Comment;
    const comment = await CommentModel.create({
      targetType,
      targetId,
      parentId: parentId || null,
      userId: req.user?.id || null,
      authorName: (req.user?.name || requestedName).slice(0, 32),
      text
    });
    const serialized = serializeComment(comment);
    if (targetType === "live") io.to(targetId).emit("stream-comment", serialized);
    res.status(201).json({ comment: serialized });
  } catch (error) {
    console.error("Could not save comment:", error);
    res.status(500).json({ error: "Could not save your comment." });
  }
});

function liveStreamPayload(stream, viewerCount = 0) {
  const creatorRecord = stream.streamerId || stream.hostUserId;
  const creator = creatorRecord && typeof creatorRecord === "object"
    ? {
      id: creatorRecord._id,
      username: creatorRecord.username,
      name: creatorRecord.name,
      avatarUrl: creatorRecord.avatarUrl || null
    }
    : null;
  const streamerId = (creatorRecord && typeof creatorRecord === "object" ? creatorRecord._id : creatorRecord) || null;
  return {
    id: stream._id,
    roomId: stream._id,
    streamerId,
    hostUserId: streamerId,
    title: stream.title || "Live stream",
    description: stream.description || "",
    thumbnailUrl: stream.thumbnailUrl || "",
    streamStatus: stream.endedAt ? "ended" : (stream.streamStatus || "live"),
    // Generate this from the current environment so changing local/public
    // media URLs does not leave existing live streams pointing at a stale host.
    playbackUrl: livePlaybackUrl(stream._id),
    startedAt: stream.startedAt,
    endedAt: stream.endedAt,
    viewerCount,
    peakConcurrentViewers: stream.peakConcurrentViewers || 0,
    totalViews: stream.totalViews || 0,
    streamer: creator
  };
}

function livePlaybackUrl(roomId) {
  // Use the frontend's same-origin proxy by default so viewers on another
  // device do not receive a URL pointing at their own localhost.
  const base = (process.env.LIVE_HLS_BASE_URL || "/hls").replace(/\/+$/, "");
  return `${base}/${roomId}/index.m3u8`;
}

function liveWhipUrl(roomId) {
  // The Vite proxy forwards /whip to MediaMTX during local development.
  // Set LIVE_WHIP_BASE_URL to a public MediaMTX URL in production.
  const base = (process.env.LIVE_WHIP_BASE_URL || "/whip").replace(/\/+$/, "");
  return `${base}/${roomId}/whip`;
}

async function getConcurrentViewerCount(roomId, now = new Date()) {
  return LiveViewerSession.countDocuments({
    roomId,
    endedAt: null,
    expiresAt: { $gt: now },
    lastHeartbeatAt: { $gte: new Date(now.getTime() - LIVE_HEARTBEAT_TTL_MS) }
  });
}

async function publishViewerCount(roomId, now = new Date()) {
  const viewerCount = await getConcurrentViewerCount(roomId, now);
  await LiveStream.updateOne(
    { _id: roomId },
    { $max: { peakConcurrentViewers: viewerCount } }
  );
  io.to(roomId).emit("live-viewer-count", { roomId, count: viewerCount });
  return viewerCount;
}

app.post("/api/live/mediamtx-auth", async (req, res) => {
  const { action, path: streamPath, user, password } = req.body || {};
  if (typeof streamPath !== "string" || !/^[a-f\d]{32}$/i.test(streamPath)) {
    res.status(403).end();
    return;
  }

  try {
    const stream = await LiveStream.findById(streamPath).select("+publisherKeyHash");
    if (!stream || stream.endedAt || stream.streamStatus === "ended") {
      res.status(403).end();
      return;
    }

    if (action === "read" || action === "playback") {
      res.status(200).end();
      return;
    }

    const suppliedHash = typeof password === "string"
      ? createHash("sha256").update(password).digest()
      : Buffer.alloc(0);
    const storedHash = stream.publisherKeyHash
      ? Buffer.from(stream.publisherKeyHash, "hex")
      : Buffer.alloc(0);
    if (
      action !== "publish" ||
      user !== "streamline" ||
      suppliedHash.length !== storedHash.length ||
      !timingSafeEqual(suppliedHash, storedHash)
    ) {
      res.status(403).end();
      return;
    }

    res.status(200).end();
  } catch (error) {
    console.error("MediaMTX authentication check failed:", error);
    res.status(500).end();
  }
});

app.get("/api/live/active", async (_req, res) => {
  try {
    const stream = await LiveStream.findOne({ endedAt: null }).sort({ startedAt: -1 }).select("_id");
    if (!stream) {
      res.status(404).json({ error: "There is no live stream right now." });
      return;
    }
    res.json({ roomId: stream._id });
  } catch (error) {
    console.error("Could not find an active live stream:", error);
    res.status(500).json({ error: "Could not find an active live stream." });
  }
});

app.get("/api/live/mine", authenticate, async (req, res) => {
  try {
    const stream = await LiveStream.findOne({
      $or: [{ streamerId: req.user.id }, { hostUserId: req.user.id }],
      endedAt: null
    }).sort({ startedAt: -1 }).populate("streamerId hostUserId", "username name avatarUrl");
    res.json({ stream: stream ? liveStreamPayload(stream) : null });
  } catch (error) {
    console.error("Could not load your live stream:", error);
    res.status(500).json({ error: "Could not load your live stream." });
  }
});

app.post("/api/live/start", authenticate, async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  const thumbnailUrl = typeof req.body?.thumbnailUrl === "string" ? req.body.thumbnailUrl.trim() : "";
  const thumbnailIsValid = !thumbnailUrl || (() => {
    try {
      return new URL(thumbnailUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();
  if (!title || title.length > 120 || description.length > 2000 ||
      thumbnailUrl.length > 2048 || !thumbnailIsValid) {
    res.status(400).json({
      error: "Enter a title up to 120 characters, description up to 2000 characters, and an optional HTTPS thumbnail URL."
    });
    return;
  }

  const roomId = randomBytes(16).toString("hex");
  const publisherKey = randomBytes(32).toString("base64url");
  try {
    const currentStream = await LiveStream.findOne({
      $or: [{ streamerId: req.user.id }, { hostUserId: req.user.id }],
      endedAt: null
    }).select("_id");
    if (currentStream) {
      res.status(409).json({
        error: "You already have a live stream. End it before starting another.",
        roomId: currentStream._id
      });
      return;
    }
    const stream = await LiveStream.create({
      _id: roomId,
      streamerId: req.user.id,
      hostUserId: req.user.id,
      title,
      description,
      thumbnailUrl,
      streamStatus: "live",
      playbackUrl: livePlaybackUrl(roomId),
      publisherKeyHash: createHash("sha256").update(publisherKey).digest("hex"),
      startedAt: new Date()
    });
    res.status(201).json({
      ...liveStreamPayload(stream),
      whipUrl: liveWhipUrl(roomId),
      publisherKey
    });
  } catch (error) {
    if (error.code === 11000) {
      res.status(409).json({ error: "You already have a live stream. End it before starting another." });
      return;
    }
    console.error("Could not create the live stream:", error);
    res.status(500).json({ error: "Could not create the live stream." });
  }
});

app.post(["/api/live/:roomId/publish-credentials", "/api/live/:id/publish-credentials"], authenticate, async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  if (!/^[a-f\d]{32}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const existing = await LiveStream.findById(roomId);
    if (!existing) {
      res.status(404).json({ error: "Live stream not found." });
      return;
    }
    const ownerId = existing.streamerId || existing.hostUserId;
    if (ownerId && ownerId !== req.user.id) {
      res.status(403).json({ error: "You are not authorized to broadcast on this live stream." });
      return;
    }
    const publisherKey = randomBytes(32).toString("base64url");
    const stream = await LiveStream.findOneAndUpdate(
      { _id: roomId, endedAt: null },
      { $set: { publisherKeyHash: createHash("sha256").update(publisherKey).digest("hex") } },
      { new: true }
    );
    if (!stream) {
      res.status(404).json({ error: "Live stream not found or has ended." });
      return;
    }
    res.set("Cache-Control", "no-store").json({
      whipUrl: liveWhipUrl(roomId),
      publisherKey
    });
  } catch (error) {
    console.error("Could not renew live publishing credentials:", error);
    res.status(500).json({ error: "Could not reconnect to the live stream." });
  }
});

app.post(["/api/live/:roomId/end", "/api/live/:id/end"], authenticate, async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  if (!/^[a-f\d]{32}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const stream = await LiveStream.findById(roomId);
    if (!stream) {
      res.status(404).json({ error: "Active live stream not found." });
      return;
    }
    const ownerId = stream.streamerId || stream.hostUserId;
    if (ownerId && ownerId !== req.user.id) {
      res.status(403).json({ error: "You are not authorized to end another user's live stream." });
      return;
    }
    const endedAt = new Date();
    await LiveStream.updateOne(
      { _id: roomId },
      { $set: { endedAt, streamStatus: "ended", publisherKeyHash: null } }
    );
    await LiveViewerSession.updateMany(
      { roomId, endedAt: null },
      { $set: { endedAt, expiresAt: endedAt } }
    );
    io.to(roomId).emit("live-stream-ended", { roomId });
    io.to(roomId).emit("live-viewer-count", { roomId, count: 0 });
    res.status(200).json({ success: true, message: "Live stream ended." });
  } catch (error) {
    console.error("Could not end live stream:", error);
    res.status(500).json({ error: "Could not end the live stream." });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const streams = await LiveStream.find({ endedAt: null })
      .sort({ startedAt: -1 })
      .limit(100)
      .populate("streamerId hostUserId", "username name avatarUrl")
      .lean();
    const results = await Promise.all(streams.map(async (stream) => ({
      ...liveStreamPayload(stream, await getConcurrentViewerCount(stream._id))
    })));
    res.json({ streams: results });
  } catch (error) {
    console.error("Could not list live streams:", error);
    res.status(500).json({ error: "Could not load live streams." });
  }
});

app.get(["/api/live/:roomId", "/api/live/:id"], async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  if (!/^[a-f\d]{32}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const stream = await LiveStream.findById(roomId)
      .populate("streamerId hostUserId", "username name avatarUrl")
      .lean();
    if (!stream) {
      res.status(404).json({ error: "Live stream not found." });
      return;
    }
    res.json({ stream: liveStreamPayload(stream, await getConcurrentViewerCount(roomId)) });
  } catch (error) {
    console.error("Could not load live stream:", error);
    res.status(500).json({ error: "Could not load live-stream details." });
  }
});

app.post(["/api/live/:roomId/join", "/api/live/:id/join"], optionalAuthenticate, async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  const viewerSessionId = req.body?.viewerSessionId;
  if (
    !/^[a-f\d]{32}$/i.test(roomId) ||
    typeof viewerSessionId !== "string" ||
    !/^[a-f\d-]{36}$/i.test(viewerSessionId)
  ) {
    res.status(400).json({ error: "A valid stream and viewer session are required." });
    return;
  }
  const now = new Date();
  try {
    if (!await LiveStream.exists({ _id: roomId, endedAt: null })) {
      res.status(404).json({ error: "This live stream has ended or does not exist." });
      return;
    }
    const update = {
      $set: {
        lastHeartbeatAt: now,
        expiresAt: new Date(now.getTime() + LIVE_HEARTBEAT_TTL_MS),
        endedAt: null,
        userId: req.user?.id || null
      },
      $setOnInsert: { connectedAt: now }
    };
    let result;
    try {
      result = await LiveViewerSession.updateOne({ roomId, viewerSessionId }, update, { upsert: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      result = await LiveViewerSession.updateOne({ roomId, viewerSessionId }, update);
    }
    if (result.upsertedCount) {
      await LiveStream.updateOne({ _id: roomId }, { $inc: { totalViews: 1 } });
    }
    const viewerCount = await publishViewerCount(roomId, now);
    res.set("Cache-Control", "no-store").json({ viewerCount, heartbeatIntervalMs: 20_000 });
  } catch (error) {
    console.error("Could not register live viewer:", error);
    res.status(500).json({ error: "Could not join this live stream." });
  }
});

app.post(["/api/live/:roomId/leave", "/api/live/:id/leave"], optionalAuthenticate, async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  const viewerSessionId = req.body?.viewerSessionId;
  if (
    !/^[a-f\d]{32}$/i.test(roomId) ||
    typeof viewerSessionId !== "string" ||
    !/^[a-f\d-]{36}$/i.test(viewerSessionId)
  ) {
    res.status(400).json({ error: "A valid stream and viewer session are required." });
    return;
  }
  try {
    await LiveViewerSession.updateOne(
      { roomId, viewerSessionId, endedAt: null },
      { $set: { endedAt: new Date(), expiresAt: new Date() } }
    );
    const viewerCount = await publishViewerCount(roomId);
    res.json({ viewerCount });
  } catch (error) {
    console.error("Could not unregister live viewer:", error);
    res.status(500).json({ error: "Could not leave this live stream cleanly." });
  }
});

app.get(["/api/live/:roomId/stats", "/api/live/:id/stats"], optionalAuthenticate, async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  if (!/^[a-f\d]{32}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const stream = await LiveStream.findById(roomId);
    if (!stream) {
      res.status(404).json({ error: "Live stream not found." });
      return;
    }
    const viewerCount = await getConcurrentViewerCount(roomId);
    await LiveStream.updateOne({ _id: roomId }, { $max: { peakConcurrentViewers: viewerCount } });
    res.set("Cache-Control", "no-store").json({
      roomId,
      viewerCount,
      peakConcurrentViewers: Math.max(stream.peakConcurrentViewers || 0, viewerCount),
      totalViews: stream.totalViews || 0,
      startedAt: stream.startedAt,
      endedAt: stream.endedAt,
      streamStatus: stream.endedAt ? "ended" : (stream.streamStatus || "live")
    });
  } catch (error) {
    console.error("Could not load live-stream statistics:", error);
    res.status(500).json({ error: "Could not load live-stream statistics." });
  }
});

app.get(["/api/live/:roomId/chat", "/api/live/:id/chat"], async (req, res) => {
  const roomId = req.params.roomId || req.params.id;
  if (!/^[a-f\d]{32}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const messages = await LiveChatMessage.find({ targetType: "live", targetId: roomId })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ messages: messages.reverse().map(serializeComment) });
  } catch (error) {
    console.error("Could not load live chat:", error);
    res.status(500).json({ error: "Could not load live chat." });
  }
});

async function getLiveEngagement(roomId, userId) {
  const session = await LiveSession.findById(roomId).populate("hostUserId", "name username avatarUrl");
  if (!session) return null;
  const [likes, viewerReaction, followerCount, following] = await Promise.all([
    LiveReaction.countDocuments({ roomId }),
    userId ? LiveReaction.exists({ roomId, userId }) : null,
    Follow.countDocuments({ followedId: session.hostUserId._id }),
    userId && userId !== session.hostUserId._id
      ? Follow.exists({ followerId: userId, followedId: session.hostUserId._id })
      : Promise.resolve(false)
  ]);
  return {
    roomId,
    live: !session.endedAt,
    likes,
    viewerReaction: viewerReaction ? "like" : null,
    creator: {
      id: session.hostUserId._id,
      username: session.hostUserId.username,
      name: session.hostUserId.name,
      avatarUrl: session.hostUserId.avatarUrl,
      followerCount,
      isFollowing: Boolean(following)
    }
  };
}

app.get("/api/live/:roomId/engagement", optionalAuthenticate, async (req, res) => {
  const { roomId } = req.params;
  if (!/^[a-z\d-]{1,80}$/i.test(roomId)) {
    res.status(400).json({ error: "Choose a valid live stream." });
    return;
  }
  try {
    const engagement = await getLiveEngagement(roomId, req.user?.id);
    if (!engagement) {
      res.status(404).json({ error: "Live stream not found." });
      return;
    }
    res.json(engagement);
  } catch (error) {
    console.error("Could not load live-stream engagement:", error);
    res.status(500).json({ error: "Could not load live-stream details." });
  }
});

app.put("/api/live/:roomId/reaction", authenticate, async (req, res) => {
  const { roomId } = req.params;
  const reaction = req.body?.reaction;
  if (!/^[a-z\d-]{1,80}$/i.test(roomId) || !["like", "none"].includes(reaction)) {
    res.status(400).json({ error: "Choose like or none for a valid live stream." });
    return;
  }
  try {
    if (!await LiveSession.exists({ _id: roomId, endedAt: null })) {
      res.status(404).json({ error: "Live stream not found." });
      return;
    }
    if (reaction === "none") {
      await LiveReaction.deleteOne({ roomId, userId: req.user.id });
    } else {
      await LiveReaction.updateOne(
        { roomId, userId: req.user.id },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    }
    const likes = await LiveReaction.countDocuments({ roomId });
    const result = { roomId, likes, viewerReaction: reaction === "none" ? null : "like" };
    io.to(roomId).emit("live-engagement-update", { roomId, likes });
    res.json(result);
  } catch (error) {
    console.error("Could not save live-stream reaction:", error);
    res.status(500).json({ error: "Could not save your live-stream reaction." });
  }
});

const PORT = Number(process.env.PORT) || 5000;
let redisPublisher;
let redisSubscriber;
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
    }
  }),
  limits: {
    fileSize: MAX_VIDEO_SIZE,
    files: 7,
    fields: 4
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "thumbnail") {
      if (!file.mimetype.startsWith("image/") || !IMAGE_EXTENSIONS.has(extension)) {
        callback(new Error("Choose a JPG, PNG, or WebP thumbnail."));
        return;
      }
    } else if (file.fieldname === "captions") {
      if (extension !== CAPTION_EXTENSION || !["text/vtt", "application/octet-stream"].includes(file.mimetype)) {
        callback(new Error("Captions must be a WebVTT (.vtt) file."));
        return;
      }
    } else if (!file.mimetype.startsWith("video/") || !VIDEO_EXTENSIONS.has(extension)) {
      callback(new Error("Choose an MP4, WebM, OGG, MOV, or M4V video file."));
      return;
    }
    callback(null, true);
  }
});

const displayVideoName = (originalName) => {
  const extension = path.extname(originalName);
  const baseName = path.basename(originalName, extension)
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 160);
  return baseName || "Untitled video";
};

function getVideoResponse(record, reactionCounts = { like: 0, dislike: 0 }, viewerReaction = null) {
  return {
    id: record._id,
    name: record.name,
    description: record.description || "",
    category: record.category || "Other",
    tags: record.tags || [],
    mimetype: record.mimetype,
    size: record.sizeBytes,
    uploadedAt: record.uploadedAt.toISOString(),
    url: `/api/videos/${record._id}`,
    thumbnailUrl: record.thumbnailFileName ? `/api/videos/${record._id}/thumbnail` : null,
    captionsUrl: record.captionsFileName ? `/api/videos/${record._id}/captions` : null,
    variants: (record.variants || []).map((variant) => ({
      quality: variant.quality,
      mimetype: variant.mimetype,
      url: `/api/videos/${record._id}/quality/${variant.quality}`
    })),
    likes: reactionCounts.like || 0,
    dislikes: reactionCounts.dislike || 0,
    viewerReaction,
    creator: record.uploadedBy
      ? { id: record.uploadedBy._id, name: record.uploadedBy.name, username: record.uploadedBy.username }
      : null
  };
}

function isSafeStoredFile(fileName, extensions) {
  return typeof fileName === "string" &&
    path.basename(fileName) === fileName &&
    extensions.has(path.extname(fileName).toLowerCase());
}

function cleanupUploadedFiles(files) {
  return Promise.all(files.filter(Boolean).map((file) =>
    fs.promises.unlink(file.path).catch((error) => {
      if (error.code !== "ENOENT") console.error("Could not remove incomplete upload:", error);
    })
  ));
}

app.get("/api/creators/:username", optionalAuthenticate, async (req, res) => {
  const username = req.params.username.toLowerCase();
  if (!/^[a-z\d_]{3,24}$/.test(username)) {
    res.status(400).json({ error: "Choose a valid creator username." });
    return;
  }
  try {
    const creator = await User.findOne({ username }).select("username name avatarUrl bio createdAt");
    if (!creator) {
      res.status(404).json({ error: "Creator not found." });
      return;
    }
    const [followerCount, following, videos] = await Promise.all([
      Follow.countDocuments({ followedId: creator._id }),
      req.user
        ? Follow.exists({ followerId: req.user.id, followedId: creator._id })
        : null,
      Video.find({ uploadedBy: creator._id })
        .sort({ uploadedAt: -1 })
        .select("name description category mimetype uploadedAt thumbnailFileName")
    ]);
    res.json({
      creator: {
        id: creator._id,
        username: creator.username,
        name: creator.name,
        avatarUrl: creator.avatarUrl,
        bio: creator.bio,
        createdAt: creator.createdAt,
        followerCount,
        isFollowing: Boolean(following)
      },
      videos: videos.map((video) => ({
        id: video._id,
        name: video.name,
        description: video.description,
        category: video.category,
        mimetype: video.mimetype,
        uploadedAt: video.uploadedAt,
        url: `/api/videos/${video._id}`,
        thumbnailUrl: video.thumbnailFileName ? `/api/videos/${video._id}/thumbnail` : null
      }))
    });
  } catch (error) {
    console.error("Could not load creator profile:", error);
    res.status(500).json({ error: "Could not load this creator profile." });
  }
});

const videoUploadFields = videoUpload.fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 },
  { name: "captions", maxCount: 1 },
  ...VIDEO_QUALITIES.map((quality) => ({ name: `variant_${quality}`, maxCount: 1 }))
]);

app.get("/api/videos", optionalAuthenticate, async (req, res) => {
  try {
    const records = await Video.find().populate("uploadedBy", "username name avatarUrl").sort({ uploadedAt: -1 });
    const ids = records.map((record) => record._id);
    const [reactionCounts, viewerReactions] = ids.length
      ? await Promise.all([
        VideoReaction.aggregate([
          { $match: { videoId: { $in: ids } } },
          { $group: { _id: { videoId: "$videoId", reaction: "$reaction" }, count: { $sum: 1 } } }
        ]),
        req.user
          ? VideoReaction.find({ videoId: { $in: ids }, userId: req.user.id }).select("videoId reaction")
          : []
      ])
      : [[], []];
    const countsByVideo = new Map();
    for (const item of reactionCounts) {
      const counts = countsByVideo.get(item._id.videoId) || { like: 0, dislike: 0, viewerReaction: null };
      counts[item._id.reaction] = item.count;
      countsByVideo.set(item._id.videoId, counts);
    }
    for (const reaction of viewerReactions) {
      const counts = countsByVideo.get(reaction.videoId) || { like: 0, dislike: 0, viewerReaction: null };
      counts.viewerReaction = reaction.reaction;
      countsByVideo.set(reaction.videoId, counts);
    }
    const videos = await Promise.all(records.map(async (record) => {
      if (!isSafeStoredFile(record.fileName, VIDEO_EXTENSIONS)) {
        throw new Error(`Video ${record._id} has an invalid stored filename.`);
      }
      try {
        await fs.promises.access(path.join(uploadDirectory, record.fileName));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        console.warn(`Skipping video ${record._id}: its media file is missing.`);
        return null;
      }
      return getVideoResponse(record, countsByVideo.get(record._id), countsByVideo.get(record._id)?.viewerReaction || null);
    }));
    res.json({ videos: videos.filter(Boolean) });
  } catch (error) {
    console.error("Could not list uploaded videos:", error);
    res.status(500).json({ error: "Could not load the video library." });
  }
});

app.post("/api/videos", optionalAuthenticate, (req, res) => {
  videoUploadFields(req, res, async (uploadError) => {
    if (uploadError) {
      await cleanupUploadedFiles(Object.values(req.files || {}).flat());
      const isTooLarge = uploadError instanceof multer.MulterError
        && uploadError.code === "LIMIT_FILE_SIZE";
      res.status(isTooLarge ? 413 : 400).json({
        error: isTooLarge
          ? "Video exceeds the 1 GB upload limit."
          : uploadError.message
      });
      return;
    }

    const files = Object.values(req.files || {}).flat();
    const primaryVideo = req.files?.video?.[0];
    if (!primaryVideo) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: "Choose a video file to upload." });
      return;
    }

    const title = typeof req.body.title === "string" && req.body.title.trim()
      ? req.body.title.trim()
      : displayVideoName(primaryVideo.originalname);
    const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
    const category = typeof req.body.category === "string" && req.body.category.trim()
      ? req.body.category.trim()
      : "Other";
    let tags;
    try {
      tags = JSON.parse(req.body.tags || "[]");
    } catch {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: "Tags must be a valid JSON list." });
      return;
    }
    if (
      title.length > 160 ||
      description.length > 2000 ||
      category.length > 60 ||
      !Array.isArray(tags) ||
      tags.length > 20 ||
      tags.some((tag) => typeof tag !== "string" || tag.trim().length > 40)
    ) {
      await cleanupUploadedFiles(files);
      res.status(400).json({ error: "Check the title, description, category, and tags (up to 20 tags)." });
      return;
    }
    const thumbnailFile = req.files?.thumbnail?.[0];
    const captionsFile = req.files?.captions?.[0];
    if (thumbnailFile && thumbnailFile.size > 10 * 1024 * 1024) {
      await cleanupUploadedFiles(files);
      res.status(413).json({ error: "Thumbnail must be 10 MB or smaller." });
      return;
    }
    if (captionsFile) {
      if (captionsFile.size > 2 * 1024 * 1024) {
        await cleanupUploadedFiles(files);
        res.status(413).json({ error: "Captions must be 2 MB or smaller." });
        return;
      }
      let captionText;
      try {
        captionText = await fs.promises.readFile(captionsFile.path, "utf8");
      } catch (error) {
        await cleanupUploadedFiles(files);
        console.error("Could not validate uploaded captions:", error);
        res.status(500).json({ error: "Could not validate the uploaded captions." });
        return;
      }
      if (!/^\uFEFF?WEBVTT(?:\r?\n|$)/.test(captionText)) {
        await cleanupUploadedFiles(files);
        res.status(400).json({ error: "Captions must be a valid WebVTT file beginning with WEBVTT." });
        return;
      }
    }

    const id = path.basename(primaryVideo.filename, path.extname(primaryVideo.filename));
    const variantFiles = VIDEO_QUALITIES.flatMap((quality) => {
      const file = req.files?.[`variant_${quality}`]?.[0];
      return file ? [{ quality, file }] : [];
    });
    try {
      const uploadedAt = new Date();
      const video = await Video.create({
        _id: id,
        name: title,
        description,
        category,
        tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))],
        mimetype: primaryVideo.mimetype,
        fileName: primaryVideo.filename,
        sizeBytes: primaryVideo.size,
        thumbnailFileName: req.files?.thumbnail?.[0]?.filename || null,
        captionsFileName: req.files?.captions?.[0]?.filename || null,
        variants: variantFiles.map(({ quality, file }) => ({
          quality,
          fileName: file.filename,
          mimetype: file.mimetype,
          sizeBytes: file.size
        })),
        uploadedBy: req.user?.id || null,
        uploadedAt
      });
      await video.populate("uploadedBy", "username name avatarUrl");
      res.status(201).json({
        video: getVideoResponse(video)
      });
    } catch (error) {
      await cleanupUploadedFiles(files);
      console.error("Could not save video record:", error);
      res.status(500).json({ error: "The video upload could not be saved." });
    }
  });
});

app.put("/api/videos/:id/reaction", authenticate, async (req, res) => {
  const { id } = req.params;
  const reaction = req.body?.reaction;
  if (!/^[a-f\d-]{36}$/i.test(id) || !["like", "dislike", "none"].includes(reaction)) {
    res.status(400).json({ error: "Choose like, dislike, or none for a valid video." });
    return;
  }
  try {
    if (!await Video.exists({ _id: id })) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    if (reaction === "none") {
      await VideoReaction.deleteOne({ videoId: id, userId: req.user.id });
    } else {
      await VideoReaction.updateOne(
        { videoId: id, userId: req.user.id },
        { $set: { reaction, createdAt: new Date() } },
        { upsert: true, runValidators: true }
      );
    }
    const counts = await VideoReaction.aggregate([
      { $match: { videoId: id } },
      { $group: { _id: "$reaction", count: { $sum: 1 } } }
    ]);
    res.json({
      likes: counts.find((item) => item._id === "like")?.count || 0,
      dislikes: counts.find((item) => item._id === "dislike")?.count || 0,
      viewerReaction: reaction === "none" ? null : reaction
    });
  } catch (error) {
    console.error("Could not save video reaction:", error);
    res.status(500).json({ error: "Could not save your reaction." });
  }
});

app.post("/api/videos/:id/report", authenticate, async (req, res) => {
  const { id } = req.params;
  const { reason, details = "" } = req.body || {};
  const allowedReasons = ["spam", "harassment", "violence", "misinformation", "copyright", "other"];
  if (
    !/^[a-f\d-]{36}$/i.test(id) ||
    !allowedReasons.includes(reason) ||
    typeof details !== "string" ||
    details.trim().length > 1000
  ) {
    res.status(400).json({ error: "Choose a report reason and enter no more than 1000 characters of details." });
    return;
  }
  try {
    if (!await Video.exists({ _id: id })) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    await VideoReport.create({
      videoId: id,
      userId: req.user.id,
      reason,
      details: details.trim(),
      createdAt: new Date()
    });
    res.status(201).json({ message: "Thank you. Your report was submitted for review." });
  } catch (error) {
    if (error.code === 11000) {
      res.status(409).json({ error: "You have already reported this video." });
      return;
    }
    console.error("Could not submit video report:", error);
    res.status(500).json({ error: "Could not submit your report." });
  }
});

app.get("/api/videos/:id/thumbnail", async (req, res) => {
  if (!/^[a-f\d-]{36}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Video not found." });
    return;
  }
  try {
    const video = await Video.findById(req.params.id).select("thumbnailFileName");
    if (!video?.thumbnailFileName || !isSafeStoredFile(video.thumbnailFileName, IMAGE_EXTENSIONS)) {
      res.status(404).json({ error: "Video thumbnail not found." });
      return;
    }
    res.sendFile(path.join(uploadDirectory, video.thumbnailFileName));
  } catch (error) {
    console.error("Could not read video thumbnail:", error);
    res.status(500).json({ error: "Could not load the video thumbnail." });
  }
});

app.get("/api/videos/:id/captions", async (req, res) => {
  if (!/^[a-f\d-]{36}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Video not found." });
    return;
  }
  try {
    const video = await Video.findById(req.params.id).select("captionsFileName");
    if (!video?.captionsFileName || !isSafeStoredFile(video.captionsFileName, new Set([CAPTION_EXTENSION]))) {
      res.status(404).json({ error: "Video captions not found." });
      return;
    }
    res.type("text/vtt");
    res.sendFile(path.join(uploadDirectory, video.captionsFileName));
  } catch (error) {
    console.error("Could not read video captions:", error);
    res.status(500).json({ error: "Could not load video captions." });
  }
});

app.get("/api/videos/:id/quality/:quality", async (req, res) => {
  if (!/^[a-f\d-]{36}$/i.test(req.params.id) || !VIDEO_QUALITIES.includes(req.params.quality)) {
    res.status(404).json({ error: "Video quality not found." });
    return;
  }
  try {
    const video = await Video.findById(req.params.id).select("variants");
    const variant = video?.variants.find((candidate) => candidate.quality === req.params.quality);
    if (!variant || !isSafeStoredFile(variant.fileName, VIDEO_EXTENSIONS)) {
      res.status(404).json({ error: "Video quality not found." });
      return;
    }
    res.type(variant.mimetype);
    res.sendFile(path.join(uploadDirectory, variant.fileName));
  } catch (error) {
    console.error("Could not stream video quality:", error);
    res.status(500).json({ error: "Could not play this video quality." });
  }
});

app.get("/api/videos/:id", async (req, res) => {
  if (!/^[a-f\d-]{36}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Video not found." });
    return;
  }

  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    if (!isSafeStoredFile(video.fileName, VIDEO_EXTENSIONS)) {
      throw new Error(`Video ${video._id} has an invalid stored filename.`);
    }
    res.type(video.mimetype);
    const filePath = path.join(uploadDirectory, video.fileName);
    const onFileError = (error) => {
      if (error && !res.headersSent) {
        console.error("Could not stream uploaded video:", error);
        res.status(error.statusCode || 500).json({ error: "Could not play this video." });
      }
    };
    if (req.query.download === "1") {
      res.download(filePath, `${video._id}${path.extname(video.fileName)}`, onFileError);
    } else {
      res.type(video.mimetype);
      res.sendFile(filePath, onFileError);
    }
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "CastError") {
      res.status(404).json({ error: "Video not found." });
      return;
    }
    console.error("Could not read uploaded video:", error);
    res.status(500).json({ error: "Could not play this video." });
  }
});

app.get("/", (req, res) => {
  res.send("StreamApp backend is running");
});

io.on("connection", (socket) => {

  console.log("Client connected:", socket.id);

  socket.on("join-live-room", async (payload) => {
    const roomId = payload?.roomId;
    if (typeof roomId !== "string" || !/^[a-f\d]{32}$/i.test(roomId)) return;
    try {
      if (!await LiveSession.exists({ _id: roomId })) return;
      if (socket.data.liveRoomId) socket.leave(socket.data.liveRoomId);
      socket.join(roomId);
      socket.data.liveRoomId = roomId;
    } catch (error) {
      console.error("Could not join live comment room:", error);
      socket.emit("stream-chat-error", "Could not connect to live comments.");
    }
  });

  socket.on("leave-live-room", () => {
    if (!socket.data.liveRoomId) return;
    socket.leave(socket.data.liveRoomId);
    socket.data.liveRoomId = null;
  });

  const leavePrivateCall = () => {
    const roomId = socket.data.privateCallRoomId;

    if (roomId) {
      socket.to(roomId).emit("call-peer-left");
      socket.leave(roomId);
      socket.data.privateCallRoomId = null;
    }
  };

  const persistMeetingJoin = async (participantSocket, roomId) => {
    const userId = participantSocket.data.user?.id;
    if (!userId) return true;
    try {
      const participant = await MeetingParticipant.create({
        roomId,
        userId,
        joinedAt: new Date()
      });
      participantSocket.data.meetingParticipantId = participant._id;
      return true;
    } catch (error) {
      console.error("Could not save meeting participation:", error);
      participantSocket.emit("group-room-error", "Could not save your meeting history.");
      return false;
    }
  };

  const admitWaitingParticipant = async (participantSocket, roomKey, roomSettings) => {
    const waitingParticipants = roomSettings.waitingParticipants;
    if (!waitingParticipants.has(participantSocket.id)) return false;

    const existingUsers = [...(io.sockets.adapter.rooms.get(roomKey) || [])];
    if (existingUsers.length >= MAX_GROUP_PARTICIPANTS) {
      waitingParticipants.delete(participantSocket.id);
      participantSocket.data.groupWaitingRoomKey = null;
      participantSocket.emit("group-room-full");
      return false;
    }

    const roomId = roomKey.slice("group-call:".length);
    if (!await persistMeetingJoin(participantSocket, roomId)) return false;
    waitingParticipants.delete(participantSocket.id);
    participantSocket.data.groupWaitingRoomKey = null;
    participantSocket.join(roomKey);
    participantSocket.data.groupCallRoomKey = roomKey;
    if (!roomSettings.hostId) roomSettings.hostId = participantSocket.id;
    roomSettings.hostEstablished = true;

    participantSocket.emit("group-room-joined", {
      participants: existingUsers,
      capacity: MAX_GROUP_PARTICIPANTS,
      hostId: roomSettings.hostId
    });
    participantSocket.to(roomKey).emit("group-participant-joined", {
      userId: participantSocket.id,
      count: existingUsers.length + 1,
      capacity: MAX_GROUP_PARTICIPANTS,
      hostId: roomSettings.hostId
    });
    return true;
  };

  const isRoomCreator = (payload, roomSettings) => {
    if (
      typeof payload?.hostKey !== "string" ||
      !/^[a-f\d]{64}$/i.test(payload.hostKey) ||
      !roomSettings.hostKeyHash
    ) {
      return false;
    }
    const suppliedHash = createHash("sha256").update(payload.hostKey).digest();
    const expectedHash = Buffer.from(roomSettings.hostKeyHash, "hex");
    return timingSafeEqual(suppliedHash, expectedHash);
  };

  const leaveGroupCall = (participantSocket = socket) => {
    const waitingRoomKey = participantSocket.data.groupWaitingRoomKey;
    if (waitingRoomKey) {
      const waitingSettings = groupRoomSettings.get(waitingRoomKey);
      waitingSettings?.waitingParticipants.delete(participantSocket.id);
      const hostId = waitingSettings?.hostId;
      if (hostId && hostId !== participantSocket.id) {
        io.to(hostId).emit("group-waiting-participant-left", {
          userId: participantSocket.id
        });
      }
      participantSocket.data.groupWaitingRoomKey = null;
    }

    const roomKey = participantSocket.data.groupCallRoomKey;
    if (!roomKey) return;
    const meetingParticipantId = participantSocket.data.meetingParticipantId;
    if (meetingParticipantId) {
      participantSocket.data.meetingParticipantId = null;
      MeetingParticipant.updateOne(
        { _id: meetingParticipantId, leftAt: null },
        { $set: { leftAt: new Date() } }
      ).catch((error) => console.error("Could not save meeting leave time:", error));
    }

    const roomSettings = groupRoomSettings.get(roomKey);
    const count = Math.max((io.sockets.adapter.rooms.get(roomKey)?.size || 1) - 1, 0);
    participantSocket.to(roomKey).emit("group-participant-left", {
      userId: participantSocket.id,
      count,
      capacity: MAX_GROUP_PARTICIPANTS
    });
    participantSocket.leave(roomKey);
    participantSocket.data.groupCallRoomKey = null;
    roomSettings?.mutedParticipants.delete(participantSocket.id);

    if (roomSettings?.hostId === participantSocket.id) {
      const activeUsers = [...(io.sockets.adapter.rooms.get(roomKey) || [])];
      roomSettings.hostId = activeUsers[0] || null;
      if (roomSettings.hostId) {
        io.to(roomKey).emit("group-host-changed", { hostId: roomSettings.hostId });
      } else {
        const nextHostId = roomSettings.waitingParticipants.values().next().value;
        const nextHost = nextHostId && io.sockets.sockets.get(nextHostId);
        if (nextHost) {
          roomSettings.hostId = nextHostId;
          void admitWaitingParticipant(nextHost, roomKey, roomSettings);
          io.to(roomKey).emit("group-host-changed", { hostId: nextHostId });
        }
      }
    }
  };

  const relayGroupSignal = (eventName, payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    const target = payload?.target;

    if (!roomKey || typeof target !== "string") return;
    if (!io.sockets.adapter.rooms.get(roomKey)?.has(target)) return;

    socket.to(target).emit(eventName, {
      sender: socket.id,
      description: payload.description,
      candidate: payload.candidate
    });
  };

  const handleLiveJoin = (payload) => {
    const roomId = payload?.roomId;
    const role = payload?.role || "viewer";
    if (typeof roomId !== "string" || !/^[a-f\d]{32}$/i.test(roomId)) return;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = role;
    console.log(`Socket ${socket.id} joined live room ${roomId} as ${role}`);
    if (role === "viewer") {
      socket.to(roomId).emit("ready");
    } else if (role === "streamer") {
      const viewersWaiting = [...(io.sockets.adapter.rooms.get(roomId) || [])]
        .some((socketId) => io.sockets.sockets.get(socketId)?.data.role === "viewer");
      if (viewersWaiting) socket.emit("ready");
    }
  };

  socket.on("join-live-room", handleLiveJoin);
  socket.on("join-room", handleLiveJoin);

  socket.on("leave-live-room", () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      socket.leave(roomId);
      socket.data.roomId = null;
    }
  });

  socket.on("offer", ({ roomId, offer }) => {

    console.log("Offer received");

    socket.to(roomId).emit("offer", offer);
  });

  socket.on("answer", ({ roomId, answer }) => {

    console.log("Answer received");

    socket.to(roomId).emit("answer", answer);
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {

    socket.to(roomId).emit(
      "ice-candidate",
      candidate
    );

  });

  socket.on("stream-chat-send", async (payload) => {
    const roomId = socket.data.roomId || payload?.roomId;
    const role = socket.data.role || payload?.role || "viewer";
    const name = typeof payload?.name === "string"
      ? payload.name.trim().slice(0, 32)
      : (socket.data.user?.name || "Viewer");
    const text = typeof payload?.text === "string"
      ? payload.text.trim().slice(0, 500)
      : "";

    if (
      !roomId ||
      !name ||
      !text
    ) {
      return;
    }

    const now = Date.now();
    const recentMessages = (socket.data.chatMessageTimes || [])
      .filter((timestamp) => now - timestamp < 10_000);

    if (recentMessages.length >= 8) {
      socket.emit("stream-chat-error", "You are sending messages too quickly.");
      return;
    }

    recentMessages.push(now);
    socket.data.chatMessageTimes = recentMessages;

    try {
      const comment = await Comment.create({
        targetType: "live",
        targetId: roomId,
        userId: socket.data.user?.id || null,
        authorName: (socket.data.user?.name || name).slice(0, 32),
        text
      });
      io.to(roomId).emit("stream-comment", serializeComment(comment));
    } catch (error) {
      console.error("Could not save live chat comment:", error);
      socket.emit("stream-chat-error", "Could not save your message. Please try again.");
    }
  });

  socket.on("leave-room", () => {

    const roomId = socket.data.roomId;

    if (roomId) {
      socket.to(roomId).emit("peer-left");
      socket.leave(roomId);
      socket.data.roomId = null;
    }
  });

  socket.on("group-join", async (payload) => {
    const roomId = payload?.roomId;

    if (typeof roomId !== "string" || !/^[a-f\d]{32}$/i.test(roomId)) {
      socket.emit("group-room-error", "Invalid private room link.");
      return;
    }

    const roomKey = `group-call:${roomId}`;
    if (socket.data.groupCallRoomKey === roomKey) {
      const participants = [...(io.sockets.adapter.rooms.get(roomKey) || [])]
        .filter((userId) => userId !== socket.id);
      socket.emit("group-room-joined", {
        participants,
        capacity: MAX_GROUP_PARTICIPANTS,
        hostId: groupRoomSettings.get(roomKey)?.hostId || socket.id
      });
      return;
    }

    let roomSettings = groupRoomSettings.get(roomKey);
    if (!roomSettings) {
      const meeting = await Meeting.findById(roomId);
      if (!meeting) {
        socket.emit("group-room-error", "This private room does not exist.");
        return;
      }
      if (meeting.endedAt) {
        socket.emit("group-room-error", "This meeting has ended. Create a new private room.");
        return;
      }
      roomSettings = {
        passwordHash: meeting.passwordHash,
        hostKeyHash: meeting.hostKeyHash,
        hostId: null,
        hostEstablished: false,
        waitingParticipants: new Set(),
        mutedParticipants: new Set(),
        ended: false
      };
      groupRoomSettings.set(roomKey, roomSettings);
    }
    if (roomSettings.ended) {
      socket.emit("group-room-error", "This meeting has ended. Create a new private room.");
      return;
    }

    const isCreator = isRoomCreator(payload, roomSettings);
    if (roomSettings.passwordHash && !isCreator) {
      if (typeof payload.password !== "string" || !payload.password) {
        socket.emit("group-password-required");
        return;
      }
      try {
        if (!await bcrypt.compare(payload.password, roomSettings.passwordHash)) {
          socket.emit("group-room-error", "That meeting password is incorrect.");
          return;
        }
      } catch (error) {
        console.error("Could not verify private room password:", error);
        socket.emit("group-room-error", "Could not verify the meeting password.");
        return;
      }
    }

    leaveGroupCall();
    leavePrivateCall();

    const existingUsers = [...(io.sockets.adapter.rooms.get(roomKey) || [])];
    if (existingUsers.length >= MAX_GROUP_PARTICIPANTS) {
      socket.emit("group-room-full");
      return;
    }

    const hostIsPresent = roomSettings.hostId && existingUsers.includes(roomSettings.hostId);
    if (hostIsPresent || (roomSettings.hostKeyHash && !isCreator)) {
      roomSettings.waitingParticipants.add(socket.id);
      socket.data.groupWaitingRoomKey = roomKey;
      socket.emit("group-approval-wait");
      if (hostIsPresent) {
        io.to(roomSettings.hostId).emit("group-waiting-participant", {
          userId: socket.id,
          waitingCount: roomSettings.waitingParticipants.size
        });
      }
      return;
    }

    if (!await persistMeetingJoin(socket, roomId)) return;
    socket.join(roomKey);
    socket.data.groupCallRoomKey = roomKey;
    roomSettings.hostId = socket.id;
    roomSettings.hostEstablished = true;
    socket.emit("group-room-joined", {
      participants: existingUsers,
      capacity: MAX_GROUP_PARTICIPANTS,
      hostId: socket.id
    });
    socket.to(roomKey).emit("group-participant-joined", {
      userId: socket.id,
      count: existingUsers.length + 1,
      capacity: MAX_GROUP_PARTICIPANTS,
      hostId: socket.id
    });
    for (const userId of roomSettings.waitingParticipants) {
      io.to(socket.id).emit("group-waiting-participant", {
        userId,
        waitingCount: roomSettings.waitingParticipants.size
      });
    }
  });

  socket.on("group-offer", (payload) => {
    relayGroupSignal("group-offer", payload);
  });

  socket.on("group-answer", (payload) => {
    relayGroupSignal("group-answer", payload);
  });

  socket.on("group-ice-candidate", (payload) => {
    relayGroupSignal("group-ice-candidate", payload);
  });

  socket.on("group-admit-participant", async (payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    const targetId = payload?.target;
    const roomSettings = roomKey && groupRoomSettings.get(roomKey);
    const target = typeof targetId === "string" && io.sockets.sockets.get(targetId);
    if (!roomSettings || roomSettings.hostId !== socket.id || !target) return;

    if (payload.approved === true) {
      await admitWaitingParticipant(target, roomKey, roomSettings);
    } else if (roomSettings.waitingParticipants.delete(targetId)) {
      target.data.groupWaitingRoomKey = null;
      target.emit("group-access-denied", "The host did not admit you to this call.");
    }
  });

  socket.on("group-remove-participant", (payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    const targetId = payload?.target;
    const roomSettings = roomKey && groupRoomSettings.get(roomKey);
    const target = typeof targetId === "string" && io.sockets.sockets.get(targetId);
    if (
      !roomSettings ||
      roomSettings.hostId !== socket.id ||
      !target ||
      target.data.groupCallRoomKey !== roomKey ||
      target.id === socket.id
    ) {
      return;
    }
    target.emit("group-removed", "The host removed you from this call.");
    leaveGroupCall(target);
  });

  socket.on("group-mute-participant", (payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    const targetId = payload?.target;
    const muted = payload?.muted;
    const roomSettings = roomKey && groupRoomSettings.get(roomKey);
    const target = typeof targetId === "string" && io.sockets.sockets.get(targetId);
    if (
      !roomSettings ||
      roomSettings.hostId !== socket.id ||
      !target ||
      target.data.groupCallRoomKey !== roomKey ||
      target.id === socket.id ||
      typeof muted !== "boolean"
    ) {
      return;
    }
    if (muted) roomSettings.mutedParticipants.add(targetId);
    else roomSettings.mutedParticipants.delete(targetId);
    target.emit("group-host-mute", { muted });
    io.to(roomKey).emit("group-participant-muted", { userId: targetId, muted });
  });

  socket.on("group-end-call", () => {
    const roomKey = socket.data.groupCallRoomKey;
    const roomSettings = roomKey && groupRoomSettings.get(roomKey);
    if (!roomSettings || roomSettings.hostId !== socket.id) return;

    roomSettings.ended = true;
    roomSettings.hostId = null;
    const roomId = roomKey.slice("group-call:".length);
    Meeting.updateOne({ _id: roomId }, { $set: { endedAt: new Date() } })
      .catch((error) => console.error("Could not save meeting end time:", error));
    for (const userId of [...(io.sockets.adapter.rooms.get(roomKey) || [])]) {
      const participant = io.sockets.sockets.get(userId);
      participant?.emit("group-meeting-ended");
      if (participant) leaveGroupCall(participant);
    }
    for (const userId of roomSettings.waitingParticipants) {
      const participant = io.sockets.sockets.get(userId);
      if (participant) {
        participant.data.groupWaitingRoomKey = null;
        participant.emit("group-meeting-ended");
      }
    }
    roomSettings.waitingParticipants.clear();
  });

  socket.on("group-raise-hand", (payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    if (!roomKey || typeof payload?.raised !== "boolean") return;
    socket.to(roomKey).emit("group-hand-raised", {
      userId: socket.id,
      raised: payload.raised
    });
  });

  socket.on("group-chat-send", (payload) => {
    const roomKey = socket.data.groupCallRoomKey;
    const text = typeof payload?.text === "string" ? payload.text.trim().slice(0, 500) : "";
    if (!roomKey || !text) return;

    const now = Date.now();
    const recentMessages = (socket.data.groupChatMessageTimes || [])
      .filter((timestamp) => now - timestamp < 10_000);
    if (recentMessages.length >= 8) {
      socket.emit("group-chat-error", "You are sending messages too quickly.");
      return;
    }
    recentMessages.push(now);
    socket.data.groupChatMessageTimes = recentMessages;
    io.to(roomKey).emit("group-chat-message", {
      id: randomUUID(),
      sender: socket.id,
      text,
      timestamp: new Date(now).toISOString()
    });
  });

  socket.on("group-leave", leaveGroupCall);

  socket.on("call-join", (payload) => {
    const roomId = payload?.roomId;

    if (typeof roomId !== "string" || !/^[a-f\d]{32}$/i.test(roomId)) {
      socket.emit("call-error", "Invalid call link.");
      return;
    }

    leavePrivateCall();
    leaveGroupCall();

    const callRoomId = `private-call:${roomId}`;
    const existingPeers = io.sockets.adapter.rooms.get(callRoomId);

    if (existingPeers?.size >= 2) {
      socket.emit("call-room-full");
      return;
    }

    const shouldOffer = !existingPeers?.size;
    socket.join(callRoomId);
    socket.data.privateCallRoomId = callRoomId;
    socket.emit("call-joined", {
      peerPresent: !shouldOffer,
      shouldOffer
    });

    if (!shouldOffer) {
      socket.to(callRoomId).emit("call-peer-joined");
    }
  });

  socket.on("call-offer", (offer) => {
    const roomId = socket.data.privateCallRoomId;
    if (roomId) socket.to(roomId).emit("call-offer", offer);
  });

  socket.on("call-answer", (answer) => {
    const roomId = socket.data.privateCallRoomId;
    if (roomId) socket.to(roomId).emit("call-answer", answer);
  });

  socket.on("call-ice-candidate", (candidate) => {
    const roomId = socket.data.privateCallRoomId;
    if (roomId) socket.to(roomId).emit("call-ice-candidate", candidate);
  });

  socket.on("call-leave", leavePrivateCall);

  socket.on("disconnect", () => {

    console.log("Client disconnected:", socket.id);

    const roomId = socket.data.roomId;

    if (roomId) {
      socket.to(roomId).emit("peer-left");
    }

    leavePrivateCall();

  });

  socket.on("disconnecting", () => {
    leaveGroupCall();
    leavePrivateCall();
  });

});

async function startServer() {
  await connectDatabase();
  if (process.env.REDIS_URL) {
    redisPublisher = createClient({ url: process.env.REDIS_URL });
    redisSubscriber = redisPublisher.duplicate();
    redisPublisher.on("error", (error) => console.error("Socket.IO Redis publisher error:", error));
    redisSubscriber.on("error", (error) => console.error("Socket.IO Redis subscriber error:", error));
    await Promise.all([redisPublisher.connect(), redisSubscriber.connect()]);
    io.adapter(createAdapter(redisPublisher, redisSubscriber));
    console.log("Socket.IO Redis adapter enabled.");
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "0.0.0.0", resolve);
  });
  console.log(`Backend running on http://localhost:${PORT}`);
}

startServer().catch(async (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Backend could not start: port ${PORT} is already in use. ` +
      "Another backend instance may already be running. Stop it or configure a different PORT."
    );
  } else {
    console.error("Backend startup failed:", error);
  }

  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    console.error("Could not close the database connection after startup failed:", disconnectError);
  }
  process.exitCode = 1;
});
