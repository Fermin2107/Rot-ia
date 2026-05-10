import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import LoginScreen from "./components/LoginScreen";
import MapaPotrero from "./components/MapaPotrero";

function App() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoadingSession(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (loadingSession) return null;
  if (!session) return <LoginScreen />;
  return <MapaPotrero onLogout={handleLogout} />;
}

export default App;
