const { randomUUID, createHash, randomInt } = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");
const { User } = require("./database");

const COOKIE_NAME = "streamline_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z\d_]{3,24}$/;
const attemptsByIp = new Map();
const sessionSecret = process.env.JWT_SECRET;
const sessionIssuer = "streamline";
const otpChallenges = new Map();
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

function isConfigured() {
  return typeof sessionSecret === "string" && Buffer.byteLength(sessionSecret) >= 32;
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber || null,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    avatarUrl: user.avatarUrl || null,
    bio: user.bio || ""
  };
}

function getSessionToken(req) {
  return getSessionTokenFromCookieHeader(req.headers.cookie || "");
}

function getSessionTokenFromCookieHeader(cookieHeader) {
  const cookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
  } catch {
    return "";
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_MS
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

function createSession(user, res) {
  const token = jwt.sign(
    { username: user.username },
    sessionSecret,
    {
      subject: user._id,
      issuer: sessionIssuer,
      expiresIn: "7d"
    }
  );
  setSessionCookie(res, token);
}

function requireConfiguration(_req, res, next) {
  if (!isConfigured()) {
    res.status(503).json({
      error: "Account sign-in is unavailable until a JWT_SECRET of at least 32 characters is configured."
    });
    return;
  }
  next();
}

function rateLimitAuth(req, res, next) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const attempt = attemptsByIp.get(key);
  const current = !attempt || now - attempt.startedAt >= windowMs
    ? { startedAt: now, count: 0 }
    : attempt;

  current.count += 1;
  attemptsByIp.set(key, current);

  if (current.count > 10) {
    res.set("Retry-After", String(Math.ceil((windowMs - (now - current.startedAt)) / 1000)));
    res.status(429).json({ error: "Too many account attempts. Please try again later." });
    return;
  }
  next();
}

async function authenticate(req, res, next) {
  if (!isConfigured()) {
    res.status(503).json({
      error: "Account service is not configured. Set JWT_SECRET to a private value of at least 32 characters in backend/.env, then restart the backend."
    });
    return;
  }

  try {
    const user = await getSessionUser(getSessionToken(req));
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Please sign in to continue." });
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    console.error("Could not authenticate request:", error);
    res.status(500).json({ error: "Could not authenticate this request." });
  }
}

async function getSessionUser(token) {
  if (!token || !isConfigured()) return null;

  let payload;
  try {
    payload = jwt.verify(token, sessionSecret, { issuer: sessionIssuer });
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return null;
    }
    throw error;
  }

  const user = await User.findById(payload.sub);
  return user ? publicUser(user) : null;
}

async function optionalAuthenticate(req, res, next) {
  try {
    req.user = await getSessionUser(getSessionToken(req));
    next();
  } catch (error) {
    console.error("Could not authenticate optional session:", error);
    res.status(500).json({ error: "Could not verify the account session." });
  }
}

function getSocketUser(cookieHeader) {
  return getSessionUser(getSessionTokenFromCookieHeader(cookieHeader || ""));
}

function normalizePhone(value) {
  return typeof value === "string" ? value.trim().replace(/[\s()-]/g, "") : "";
}

async function sendOtp(phoneNumber) {
  const code = String(randomInt(100000, 1000000));
  const challenge = {
    hash: createHash("sha256").update(code).digest("hex"),
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0
  };
  otpChallenges.set(phoneNumber, challenge);

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    const body = new URLSearchParams({
      To: phoneNumber,
      From: process.env.TWILIO_FROM_NUMBER,
      Body: `Your Streamline verification code is ${code}. It expires in 5 minutes.`
    });
    const credentials = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body }
    );
    if (!response.ok) throw new Error("SMS provider rejected the OTP request.");
  } else {
    console.log(`[OTP development mode] ${phoneNumber}: ${code}`);
  }
}

function verifyOtp(phoneNumber, code) {
  const challenge = otpChallenges.get(phoneNumber);
  if (!challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) return false;
  challenge.attempts += 1;
  const hash = createHash("sha256").update(code).digest("hex");
  if (hash !== challenge.hash) return false;
  otpChallenges.delete(phoneNumber);
  return true;
}

const authRouter = express.Router();

authRouter.post("/register", requireConfiguration, rateLimitAuth, async (req, res) => {
  const username = typeof req.body?.username === "string"
    ? req.body.username.trim().toLowerCase()
    : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body?.password;

  if (!USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: "Username must be 3–24 characters using letters, numbers, or underscores." });
    return;
  }
  if (!name || name.length > 60) {
    res.status(400).json({ error: "Enter a name no longer than 60 characters." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
    res.status(400).json({ error: "Password must be at least 8 characters and no more than 72 UTF-8 bytes." });
    return;
  }

  try {
    const user = await User.create({
      _id: randomUUID(),
      username,
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12)
    });
    createSession(user, res);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === 11000) {
      res.status(409).json({
        error: error.keyPattern?.username
          ? "That username is already taken."
          : "An account with that email already exists."
      });
      return;
    }
    console.error("Could not create account:", error);
    res.status(500).json({ error: "Could not create your account. Please try again." });
  }
});

authRouter.post("/login", requireConfiguration, rateLimitAuth, async (req, res) => {
  const username = typeof req.body?.username === "string"
    ? req.body.username.trim().toLowerCase()
    : "";
  const password = req.body?.password;

  if (!USERNAME_PATTERN.test(username) || typeof password !== "string" || !password) {
    res.status(400).json({ error: "Enter a valid username and password." });
    return;
  }

  try {
    const user = await User.findOne({ username }).select("+passwordHash");
    const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !passwordMatches) {
      res.status(401).json({ error: "Incorrect username or password." });
      return;
    }
    createSession(user, res);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Could not sign in:", error);
    res.status(500).json({ error: "Could not sign in. Please try again." });
  }
});

authRouter.post("/otp/request", requireConfiguration, rateLimitAuth, async (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  if (!PHONE_PATTERN.test(phoneNumber)) {
    res.status(400).json({ error: "Enter a phone number in international format, for example +919876543210." });
    return;
  }
  try {
    if (!await User.exists({ phoneNumber, phoneVerifiedAt: { $ne: null } })) {
      res.status(404).json({ error: "No verified account is linked to that mobile number." });
      return;
    }
    await sendOtp(phoneNumber);
    res.json({ ok: true, message: "A verification code was sent to your mobile number." });
  } catch (error) {
    console.error("Could not send OTP:", error);
    res.status(502).json({ error: "Could not send the verification code. Please try again." });
  }
});

authRouter.post("/otp/verify", requireConfiguration, rateLimitAuth, async (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!PHONE_PATTERN.test(phoneNumber) || !/^\d{6}$/.test(code) || !verifyOtp(phoneNumber, code)) {
    res.status(401).json({ error: "That verification code is invalid or expired." });
    return;
  }
  try {
    const user = await User.findOne({ phoneNumber, phoneVerifiedAt: { $ne: null } });
    if (!user) {
      res.status(404).json({ error: "No verified account is linked to that mobile number." });
      return;
    }
    createSession(user, res);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Could not sign in with OTP:", error);
    res.status(500).json({ error: "Could not sign in. Please try again." });
  }
});

authRouter.post("/phone/request", requireConfiguration, authenticate, rateLimitAuth, async (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  if (!PHONE_PATTERN.test(phoneNumber)) {
    res.status(400).json({ error: "Enter a phone number in international format, for example +919876543210." });
    return;
  }
  if (await User.exists({ phoneNumber, _id: { $ne: req.user.id } })) {
    res.status(409).json({ error: "That mobile number is already linked to another account." });
    return;
  }
  try {
    await sendOtp(phoneNumber);
    otpChallenges.get(phoneNumber).userId = req.user.id;
    res.json({ ok: true, message: "A verification code was sent to your mobile number." });
  } catch (error) {
    console.error("Could not send phone-link OTP:", error);
    res.status(502).json({ error: "Could not send the verification code. Please try again." });
  }
});

authRouter.post("/phone/verify", requireConfiguration, authenticate, rateLimitAuth, async (req, res) => {
  const phoneNumber = normalizePhone(req.body?.phoneNumber);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const challenge = otpChallenges.get(phoneNumber);
  if (!PHONE_PATTERN.test(phoneNumber) || challenge?.userId !== req.user.id || !/^\d{6}$/.test(code) || !verifyOtp(phoneNumber, code)) {
    res.status(401).json({ error: "That verification code is invalid or expired." });
    return;
  }
  try {
    const user = await User.findByIdAndUpdate(req.user.id, { phoneNumber, phoneVerifiedAt: new Date() }, { new: true, runValidators: true });
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Could not link phone number:", error);
    res.status(500).json({ error: "Could not link your mobile number." });
  }
});

authRouter.get("/me", requireConfiguration, authenticate, (req, res) => {
  res.json({ user: req.user });
});

authRouter.patch("/me", requireConfiguration, authenticate, async (req, res) => {
  const updates = {};
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 60) {
      res.status(400).json({ error: "Name must be between 1 and 60 characters." });
      return;
    }
    updates.name = name;
  }
  if (req.body?.bio !== undefined) {
    const bio = typeof req.body.bio === "string" ? req.body.bio.trim() : null;
    if (bio === null || bio.length > 280) {
      res.status(400).json({ error: "Bio cannot exceed 280 characters." });
      return;
    }
    updates.bio = bio;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ error: "Provide a name or bio to update." });
    return;
  }

  try {
    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true
    });
    if (!user) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Could not update profile:", error);
    res.status(500).json({ error: "Could not update your profile." });
  }
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = { authRouter, authenticate, optionalAuthenticate, getSocketUser, publicUser };
