import { useState } from "react";
import { supabase } from "../supabaseClient";

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px 16px",
    background: "linear-gradient(180deg, #eef4ea 0%, #dde8d7 100%)",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxSizing: "border-box",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: "#ffffff",
    borderRadius: "18px",
    padding: "28px 20px 24px",
    boxShadow: "0 10px 28px rgba(47, 84, 42, 0.16)",
    border: "1px solid #dce7d6",
  },
  brand: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "22px" },
  logo: {
    width: "62px", height: "62px", borderRadius: "50%", backgroundColor: "#2f6a3a",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 8px 16px rgba(47, 106, 58, 0.28)", marginBottom: "10px",
  },
  logoLeaf: { fontSize: "28px" },
  title: { margin: 0, fontSize: "30px", color: "#244d2f", letterSpacing: "0.5px" },
  form: { display: "flex", flexDirection: "column", gap: "10px" },
  label: { fontSize: "14px", fontWeight: 600, color: "#355c3b" },
  input: {
    height: "44px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5", padding: "0 12px", fontSize: "15px",
    outline: "none", color: "#2a3f2f", marginBottom: "2px",
  },
  button: {
    marginTop: "8px", height: "46px", borderRadius: "12px", border: "none",
    backgroundColor: "#3d7f49", color: "#ffffff", fontSize: "16px", fontWeight: 700, cursor: "pointer",
  },
  buttonSecondary: {
    height: "46px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0", color: "#355c3b", fontSize: "16px", fontWeight: 600, cursor: "pointer",
  },
  loginMessage: {
    margin: "4px 0 0", fontSize: "13px", fontWeight: 500, lineHeight: 1.4,
  },
};

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage({ text: error.message, isError: true });
    setLoading(false);
  };

  const handleRegister = async () => {
    if (!email || !password) {
      setMessage({ text: "Ingresá email y contraseña.", isError: true });
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) setMessage({ text: error.message, isError: true });
    else setMessage({ text: "Revisá tu email para confirmar la cuenta.", isError: false });
    setLoading(false);
  };

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.brand}>
          <div style={styles.logo} aria-hidden="true">
            <span style={styles.logoLeaf}>🌿</span>
          </div>
          <h1 style={styles.title}>Rotia</h1>
        </div>

        <form style={styles.form} onSubmit={handleLogin}>
          <label htmlFor="email" style={styles.label}>Email</label>
          <input
            id="email"
            type="email"
            placeholder="tu@email.com"
            style={styles.input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <label htmlFor="password" style={styles.label}>Contraseña</label>
          <input
            id="password"
            type="password"
            placeholder="••••••••"
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {message && (
            <p style={{ ...styles.loginMessage, color: message.isError ? "#b94040" : "#2f6a3a" }}>
              {message.text}
            </p>
          )}

          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "Ingresando…" : "Ingresar"}
          </button>
          <button
            type="button"
            style={styles.buttonSecondary}
            onClick={handleRegister}
            disabled={loading}
          >
            Registrarse
          </button>
        </form>
      </section>
    </main>
  );
}
