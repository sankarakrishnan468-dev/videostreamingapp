import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./Login.css";

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [loginMethod, setLoginMethod] = useState("password");
  const [otpSent, setOtpSent] = useState(false);
  const [notice, setNotice] = useState("");
  const isRegistering = mode === "register";

  const submitForm = async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    if (!isRegistering && loginMethod === "otp") {
      const otpRequest = { phoneNumber: formData.get("phoneNumber") };
      if (otpSent) otpRequest.code = formData.get("otp");
      try {
        const response = await fetch(`/api/auth/otp/${otpSent ? "verify" : "request"}`, {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(otpRequest)
        });
        const data = await response.json();
        if (!response.ok) { setNotice(data.error || "Could not verify the code."); return; }
        if (!otpSent) { setOtpSent(true); setNotice(data.message); return; }
        navigate("/account");
      } catch (error) {
        console.error("Could not complete OTP sign-in:", error);
        setNotice("Could not reach the account service. Check that the backend is running.");
      }
      return;
    }

    if (isRegistering && formData.get("password") !== formData.get("confirmPassword")) {
      setNotice("Those passwords don't match. Please try again.");
      return;
    }

    setNotice("");
    try {
      const response = await fetch(`/api/auth/${isRegistering ? "register" : "login"}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
          ...(isRegistering && {
            name: formData.get("name"),
            email: formData.get("email")
          })
        })
      });
      const data = await response.json();

      if (!response.ok) {
        setNotice(data.error || "Could not sign in. Please try again.");
        return;
      }

      navigate("/account");
    } catch (error) {
      console.error("Could not reach account service:", error);
      setNotice("Could not reach the account service. Check that the backend is running.");
    }
  };

  const selectMode = (nextMode) => {
    setMode(nextMode);
    setLoginMethod("password");
    setOtpSent(false);
    setNotice("");
  };

  return (
    <main className="account-page">
      <header className="account-header">
        <Link className="brand" to="/" aria-label="Streamline home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>streamline</span>
        </Link>
        <Link className="account-home-link" to="/account">Preview dashboard</Link>
      </header>

      <section className="account-layout">
        <section className="account-card" aria-labelledby="account-title">
          <div className="account-form-content">
            <p className="account-form-eyebrow">{isRegistering ? "START YOUR STORY" : "WELCOME BACK"}</p>
            <h2 id="account-title">{isRegistering ? "Create your account" : "Good to see you."}</h2>
            <p className="account-form-intro">
              {isRegistering ? "A home for your favorite streams and creators." : "Sign in to find your people and pick up where you left off."}
            </p>

            <div className="account-socials">
              <button type="button" onClick={() => setNotice("Google sign-in isn't connected yet.")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="#4285F4" d="M19.6 10.23c0-.68-.06-1.36-.18-2.02H10v3.83h5.39a4.62 4.62 0 0 1-2 3.03v2.48h3.24c1.9-1.75 2.97-4.33 2.97-7.32Z" /><path fill="#34A853" d="M10 20c2.7 0 4.97-.9 6.63-2.45l-3.24-2.48c-.9.6-2.04.96-3.39.96-2.6 0-4.8-1.75-5.59-4.1H1.06v2.56A10 10 0 0 0 10 20Z" /><path fill="#FBBC05" d="M4.41 11.93a6.01 6.01 0 0 1 0-3.86V5.51H1.06a10 10 0 0 0 0 8.98l3.35-2.56Z" /><path fill="#EA4335" d="M10 3.97c1.47 0 2.79.5 3.82 1.5l2.87-2.87C14.96.99 12.7 0 10 0a10 10 0 0 0-8.94 5.51l3.35 2.56C5.2 5.72 7.4 3.97 10 3.97Z" /></svg>
                Google
              </button>
              <button type="button" onClick={() => setNotice("GitHub sign-in isn't connected yet.")}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 .8a9.2 9.2 0 0 0-2.91 17.93c.46.08.63-.2.63-.45v-1.6c-2.57.56-3.11-1.1-3.11-1.1-.42-1.07-1.03-1.36-1.03-1.36-.84-.57.06-.56.06-.56.93.07 1.42.95 1.42.95.82 1.41 2.15 1 2.67.76.08-.59.32-1 .58-1.23-2.05-.23-4.21-1.03-4.21-4.57 0-1 .36-1.82.95-2.46-.1-.23-.41-1.17.09-2.43 0 0 .77-.25 2.53.94a8.8 8.8 0 0 1 4.61 0c1.76-1.19 2.53-.94 2.53-.94.5 1.26.19 2.2.09 2.43.59.64.95 1.46.95 2.46 0 3.55-2.16 4.33-4.22 4.56.33.29.62.85.62 1.72v2.43c0 .25.17.53.64.44A9.2 9.2 0 0 0 10 .8Z" /></svg>
                GitHub
              </button>
            </div>

            <div className="account-divider"><span />or continue with {isRegistering ? "username and email" : "username"}<span /></div>

            {!isRegistering && (
              <div className="account-login-methods" role="group" aria-label="Sign-in method">
                <button type="button" className={loginMethod === "password" ? "active" : ""} onClick={() => { setLoginMethod("password"); setOtpSent(false); setNotice(""); }}>Password</button>
                <button type="button" className={loginMethod === "otp" ? "active" : ""} onClick={() => { setLoginMethod("otp"); setOtpSent(false); setNotice(""); }}>Mobile OTP</button>
              </div>
            )}

            <form className="account-form" onSubmit={submitForm}>
              {!isRegistering && loginMethod === "otp" && <label>
                Mobile number
                <input name="phoneNumber" type="tel" autoComplete="tel" placeholder="+919876543210" pattern="\+[1-9][0-9]{7,14}" required />
              </label>}
              {!isRegistering && loginMethod === "otp" && otpSent && <label>
                Verification code
                <input name="otp" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" pattern="[0-9]{6}" maxLength={6} required />
              </label>}
              {isRegistering && (
                <label>
                  Your name
                  <input name="name" type="text" autoComplete="name" placeholder="How should we call you?" required />
                </label>
              )}
              <label className={!isRegistering && loginMethod === "otp" ? "otp-hidden-field" : ""}>
                Username
                <input
                  name="username"
                  type="text"
                  autoComplete="username"
                  placeholder="3-24 letters, numbers, or underscores"
                  minLength={3}
                  maxLength={24}
                  pattern="[A-Za-z0-9_]{3,24}"
                  required={isRegistering || loginMethod === "password"}
                  disabled={!isRegistering && loginMethod === "otp"}
                />
              </label>
              {isRegistering && (
                <label>
                  Email address
                  <input name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
                </label>
              )}
              <label className={!isRegistering && loginMethod === "otp" ? "otp-hidden-field" : ""}>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={isRegistering ? "new-password" : "current-password"}
                  placeholder={isRegistering ? "At least 8 characters" : "Enter your password"}
                  minLength={isRegistering ? 8 : undefined}
                  required={isRegistering || loginMethod === "password"}
                  disabled={!isRegistering && loginMethod === "otp"}
                />
              </label>
              {isRegistering ? (
                <label>
                  Confirm password
                  <input name="confirmPassword" type="password" autoComplete="new-password" placeholder="Enter your password again" minLength={8} required />
                </label>
              ) : (
                  <div className={loginMethod === "otp" ? "account-form-options otp-hidden-field" : "account-form-options"}>
                  <label className="account-remember"><input type="checkbox" name="remember" /> <span>Remember me</span></label>
                  <button className="account-text-button" type="button" onClick={() => setNotice("Password reset isn't connected yet.")}>Forgot password?</button>
                </div>
              )}
              <div className="account-actions">
                <button className="account-submit" type="submit">
                  {isRegistering ? "Create account" : "Sign in"}<span aria-hidden="true">→</span>
                </button>
                <button
                  className="account-signup-button"
                  type="button"
                  onClick={() => selectMode(isRegistering ? "login" : "register")}
                >
                  {isRegistering ? "Back to sign in" : "Sign up"}
                </button>
              </div>
              {notice && <p className="account-notice" role="status">{notice}</p>}
            </form>

            <p className="account-terms">
              By continuing, you agree to our Terms and Privacy Policy.
            </p>
            <p className="account-preview-notice">Google and GitHub sign-in, password recovery, and profile editing are not configured.</p>
          </div>
        </section>
      </section>

      <footer className="account-footer">
        <span>Streamline · Watch together, your way.</span>
        <Link to="/">Explore without an account <span aria-hidden="true">→</span></Link>
      </footer>
    </main>
  );
}

export default Login;
