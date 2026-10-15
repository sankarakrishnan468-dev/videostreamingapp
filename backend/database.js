const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  _id: { type: String, default: () => require("crypto").randomUUID() },
  username: { type: String, required: true, trim: true, lowercase: true, unique: true, minlength: 3, maxlength: 24 },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true, maxlength: 16 },
  phoneVerifiedAt: { type: Date, default: null },
  passwordHash: { type: String, required: true, select: false },
  avatarUrl: { type: String, default: null },
  bio: { type: String, default: "", maxlength: 280 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const videoSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true, maxlength: 160 },
  description: { type: String, default: "", maxlength: 2000 },
  thumbnailUrl: { type: String, default: "", maxlength: 2048 },
  category: { type: String, default: "Other", maxlength: 60 },
  tags: { type: [String], default: [] },
  mimetype: { type: String, required: true },
  fileName: { type: String, required: true, unique: true },
  sizeBytes: { type: Number, required: true, min: 0 },
  thumbnailFileName: { type: String, default: null },
  captionsFileName: { type: String, default: null },
  variants: {
    type: [{
      quality: { type: String, required: true },
      fileName: { type: String, required: true },
      mimetype: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 0 }
    }],
    default: []
  },
  uploadedBy: { type: String, ref: "User", default: null },
  uploadedAt: { type: Date, default: Date.now }
}, { versionKey: false });
videoSchema.index({ uploadedAt: -1 });
videoSchema.index({ category: 1, uploadedAt: -1 });

const videoReactionSchema = new mongoose.Schema({
  videoId: { type: String, ref: "Video", required: true },
  userId: { type: String, ref: "User", required: true },
  reaction: { type: String, enum: ["like", "dislike"], required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
videoReactionSchema.index({ videoId: 1, userId: 1 }, { unique: true });
videoReactionSchema.index({ videoId: 1, reaction: 1 });

const commentSchema = new mongoose.Schema({
  targetType: { type: String, enum: ["video", "live"], required: true },
  targetId: { type: String, required: true },
  userId: { type: String, ref: "User", default: null },
  authorName: { type: String, required: true, maxlength: 32 },
  text: { type: String, required: true, maxlength: 500 },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
commentSchema.index({ targetType: 1, targetId: 1, createdAt: 1 });
commentSchema.index({ parentId: 1, createdAt: 1 });

const liveReactionSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  userId: { type: String, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
liveReactionSchema.index({ roomId: 1, userId: 1 }, { unique: true });
liveReactionSchema.index({ roomId: 1 });

const liveSessionSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  streamerId: { type: String, ref: "User", required: true },
  hostUserId: { type: String, ref: "User" },
  title: { type: String, required: true, trim: true, maxlength: 120, default: "Live stream" },
  description: { type: String, default: "", maxlength: 2000 },
  thumbnailUrl: { type: String, default: "", maxlength: 2048 },
  streamStatus: { type: String, enum: ["live", "ended"], default: "live" },
  playbackUrl: { type: String, default: "" },
  publisherKeyHash: { type: String, default: null, select: false },
  peakConcurrentViewers: { type: Number, default: 0, min: 0 },
  totalViews: { type: Number, default: 0, min: 0 },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null }
}, { versionKey: false });

liveSessionSchema.pre("validate", function() {
  if (!this.streamerId && this.hostUserId) this.streamerId = this.hostUserId;
  if (!this.hostUserId && this.streamerId) this.hostUserId = this.streamerId;
});

liveSessionSchema.index({ streamerId: 1, endedAt: 1, startedAt: -1 });
liveSessionSchema.index({ hostUserId: 1, endedAt: 1, startedAt: -1 });
liveSessionSchema.index(
  { streamerId: 1 },
  { unique: true, partialFilterExpression: { endedAt: null } }
);
liveSessionSchema.index(
  { hostUserId: 1 },
  { unique: true, partialFilterExpression: { endedAt: null } }
);
liveSessionSchema.index({ startedAt: -1 });

const liveViewerSessionSchema = new mongoose.Schema({
  roomId: { type: String, ref: "LiveStream", required: true },
  viewerSessionId: { type: String, required: true },
  userId: { type: String, ref: "User", default: null },
  connectedAt: { type: Date, default: Date.now },
  lastHeartbeatAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date, default: null }
}, { versionKey: false });
liveViewerSessionSchema.index({ roomId: 1, viewerSessionId: 1 }, { unique: true });
liveViewerSessionSchema.index({ roomId: 1, endedAt: 1, lastHeartbeatAt: 1 });
liveViewerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const liveChatMessageSchema = new mongoose.Schema({
  targetType: { type: String, enum: ["live"], required: true, default: "live" },
  targetId: { type: String, required: true },
  userId: { type: String, ref: "User", default: null },
  authorName: { type: String, required: true, maxlength: 32 },
  text: { type: String, required: true, maxlength: 500 },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveChatMessage", default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false, collection: "comments" });
liveChatMessageSchema.virtual("streamId").get(function() {
  return this.targetId;
});
liveChatMessageSchema.set("toJSON", { virtuals: true });
liveChatMessageSchema.set("toObject", { virtuals: true });
liveChatMessageSchema.index({ targetType: 1, targetId: 1, createdAt: 1 });
liveChatMessageSchema.index({ parentId: 1, createdAt: 1 });

const videoReportSchema = new mongoose.Schema({
  videoId: { type: String, ref: "Video", required: true },
  userId: { type: String, ref: "User", required: true },
  reason: {
    type: String,
    enum: ["spam", "harassment", "violence", "misinformation", "copyright", "other"],
    required: true
  },
  details: { type: String, default: "", maxlength: 1000 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
videoReportSchema.index({ videoId: 1, userId: 1 }, { unique: true });
videoReportSchema.index({ createdAt: -1 });

const followSchema = new mongoose.Schema({
  followerId: { type: String, ref: "User", required: true },
  followedId: { type: String, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
followSchema.index({ followerId: 1, followedId: 1 }, { unique: true });
followSchema.index({ followedId: 1 });

const watchHistorySchema = new mongoose.Schema({
  userId: { type: String, ref: "User", required: true },
  videoId: { type: String, ref: "Video", required: true },
  positionSeconds: { type: Number, default: 0, min: 0 },
  durationSeconds: { type: Number, default: 0, min: 0 },
  lastWatchedAt: { type: Date, default: Date.now }
}, { versionKey: false });
watchHistorySchema.index({ userId: 1, videoId: 1 }, { unique: true });
watchHistorySchema.index({ userId: 1, lastWatchedAt: -1 });

const savedVideoSchema = new mongoose.Schema({
  userId: { type: String, ref: "User", required: true },
  videoId: { type: String, ref: "Video", required: true },
  listType: { type: String, enum: ["favorite", "watch_later"], required: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
savedVideoSchema.index({ userId: 1, videoId: 1, listType: 1 }, { unique: true });
savedVideoSchema.index({ userId: 1, listType: 1, createdAt: -1 });

const meetingSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  hostUserId: { type: String, ref: "User", default: null },
  passwordHash: { type: String, default: null },
  hostKeyHash: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null }
}, { versionKey: false });

const meetingParticipantSchema = new mongoose.Schema({
  roomId: { type: String, ref: "Meeting", required: true },
  userId: { type: String, ref: "User", required: true },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date, default: null }
}, { versionKey: false });
meetingParticipantSchema.index({ roomId: 1, userId: 1, joinedAt: 1 }, { unique: true });
meetingParticipantSchema.index({ userId: 1, joinedAt: -1 });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Video = mongoose.models.Video || mongoose.model("Video", videoSchema);
const VideoReaction = mongoose.models.VideoReaction || mongoose.model("VideoReaction", videoReactionSchema);
const Comment = mongoose.models.Comment || mongoose.model("Comment", commentSchema);
const LiveReaction = mongoose.models.LiveReaction || mongoose.model("LiveReaction", liveReactionSchema);
const LiveStream = mongoose.models.LiveStream
  || mongoose.model("LiveStream", liveSessionSchema, "livesessions");
const LiveSession = LiveStream;
const LiveViewerSession = mongoose.models.LiveViewerSession
  || mongoose.model("LiveViewerSession", liveViewerSessionSchema);
const LiveChatMessage = mongoose.models.LiveChatMessage
  || mongoose.model("LiveChatMessage", liveChatMessageSchema, "comments");
const VideoReport = mongoose.models.VideoReport || mongoose.model("VideoReport", videoReportSchema);
const Follow = mongoose.models.Follow || mongoose.model("Follow", followSchema);
const WatchHistory = mongoose.models.WatchHistory || mongoose.model("WatchHistory", watchHistorySchema);
const SavedVideo = mongoose.models.SavedVideo || mongoose.model("SavedVideo", savedVideoSchema);
const Meeting = mongoose.models.Meeting || mongoose.model("Meeting", meetingSchema);
const MeetingParticipant = mongoose.models.MeetingParticipant
  || mongoose.model("MeetingParticipant", meetingParticipantSchema);

async function migrateLegacyUsers() {
  const legacyFile = path.join(__dirname, "data", "users.json");
  if (!fs.existsSync(legacyFile)) return;

  const legacyUsers = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  if (!Array.isArray(legacyUsers)) {
    throw new Error("Legacy user data must be an array; MongoDB migration was not applied.");
  }
  const users = legacyUsers.map((user) => {
    if (
      !user ||
      typeof user.id !== "string" ||
      typeof user.username !== "string" ||
      typeof user.name !== "string" ||
      typeof user.email !== "string" ||
      typeof user.passwordHash !== "string"
    ) {
      throw new Error("Legacy user record is invalid; MongoDB migration was not applied.");
    }
    return {
      _id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      passwordHash: user.passwordHash,
      createdAt: user.createdAt || new Date()
    };
  });

  if (users.length) {
    await User.insertMany(users, { ordered: true });
  }
  fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  console.log(`Migrated ${users.length} legacy user records into MongoDB.`);
}

async function migrateLegacyVideoMetadata() {
  const uploadsDirectory = path.join(__dirname, "uploads");
  if (!fs.existsSync(uploadsDirectory)) return;

  const files = fs.readdirSync(uploadsDirectory);
  const migratedFiles = [];
  for (const metadataFileName of files) {
    if (!/^[a-f\d-]{36}\.json$/i.test(metadataFileName)) continue;

    const id = path.basename(metadataFileName, ".json");
    const metadataFile = path.join(uploadsDirectory, metadataFileName);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const videoFileName = files.find((candidate) =>
      candidate.startsWith(`${id}.`) &&
      [".mp4", ".webm", ".ogg", ".mov", ".m4v"].includes(path.extname(candidate).toLowerCase())
    );
    if (!videoFileName) continue;

    const stat = fs.statSync(path.join(uploadsDirectory, videoFileName));
    await Video.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          name: metadata.name,
          mimetype: metadata.mimetype,
          fileName: videoFileName,
          sizeBytes: stat.size,
          uploadedAt: stat.birthtime
        }
      },
      { upsert: true }
    );
    migratedFiles.push(metadataFile);
  }

  for (const metadataFile of migratedFiles) {
    fs.renameSync(metadataFile, `${metadataFile}.migrated`);
  }
  if (migratedFiles.length) {
    console.log(`Migrated ${migratedFiles.length} legacy video records into MongoDB.`);
  }
}

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required. Set it in backend/.env before starting the backend.");
  }

  await mongoose.connect(uri);
  await Promise.all([
    User.init(),
    Video.init(),
    VideoReaction.init(),
    Comment.init(),
    LiveReaction.init(),
    LiveSession.init(),
    LiveViewerSession.init(),
    LiveChatMessage.init(),
    VideoReport.init(),
    Follow.init(),
    WatchHistory.init(),
    SavedVideo.init(),
    Meeting.init(),
    MeetingParticipant.init()
  ]);
  await migrateLegacyUsers();
  await migrateLegacyVideoMetadata();
  console.log(`Connected to MongoDB database "${mongoose.connection.name}".`);
}

module.exports = {
  connectDatabase,
  mongoose,
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
  MeetingParticipant
};
