// Supabase connection for this site.
// Both values are meant to be public: the anon key only lets a signed-in user call
// the po_* database functions. Every access rule lives in supabase/schema.sql.
window.SILFAB_CONFIG = {
  supabaseUrl: 'YOUR_SUPABASE_URL',        // e.g. https://abcdefghijklmnop.supabase.co
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
};
