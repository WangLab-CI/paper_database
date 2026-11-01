// Portal configuration.
// The GitHub Actions deploy workflow replaces the __PLACEHOLDERS__ with the
// repository variables SUPABASE_URL and SUPABASE_ANON_KEY. You can also
// paste the values here directly: the anon/publishable key is designed to be
// public — data is protected by Row Level Security in supabase/schema.sql.
window.PORTAL_CONFIG = {
  SUPABASE_URL: "https://svdushruibzmvgcilxux.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Hr-UaHf_sGA7Iok1bzNaEA_cPdjJXwx",
  LAB_NAME: "Wang Lab",
  // Sign-in methods shown on the login page: "github", "google", "email"
  AUTH_PROVIDERS: "github,email",
};
