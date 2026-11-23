// Where the page finds the Silfab Procure server (server/server.js).
// Normally leave apiUrl empty: on this PC the page uses the local server, and elsewhere it reads
// the current Cloudflare tunnel address from tunnel.json, which tools/start-tunnel.ps1 publishes.
// Set apiUrl only to force a fixed server address.
window.SILFAB_CONFIG = {
  apiUrl: '',
};
