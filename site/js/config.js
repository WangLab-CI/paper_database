// Portal configuration.
// The GitHub Actions deploy workflow replaces the __PLACEHOLDERS__ with the
// repository variables SUPABASE_URL and SUPABASE_ANON_KEY. You can also
// paste the values here directly: the anon/publishable key is designed to be
// public — data is protected by Row Level Security in supabase/schema.sql.
window.PORTAL_CONFIG = {
  SUPABASE_URL: "__SUPABASE_URL__",
  SUPABASE_ANON_KEY: "__SUPABASE_ANON_KEY__",
  LAB_NAME: "__LAB_NAME__",
  // Sign-in methods shown on the login page: "github", "google", "email"
  AUTH_PROVIDERS: "__AUTH_PROVIDERS__",
};
