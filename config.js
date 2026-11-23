// Where the page finds the Silfab Procure server (server/server.js).
// tools/start-tunnel.ps1 rewrites apiUrl with the current Cloudflare tunnel address each time it
// starts. On the PC itself (http://localhost:8490) the page ignores it and uses the local server.
window.SILFAB_CONFIG = {
  apiUrl: 'https://supplements-doom-neon-tampa.trycloudflare.com',
};