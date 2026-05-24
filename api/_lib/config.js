// Shared configuration — single source of truth for admin/starosta parsing.
// Every API file should import from here instead of re-parsing env vars.

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const STAROSTA_ACCOUNTS = {};
(process.env.STAROSTA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
  const sep = entry.indexOf(':');
  if (sep > 0) {
    const username = entry.slice(0, sep).trim().toLowerCase();
    const group = entry.slice(sep + 1).trim();
    if (username && group) STAROSTA_ACCOUNTS[username] = group;
  }
});

function getUserRole(username, userData) {
  if (ADMIN_USERNAMES.includes(username)) return 'admin';
  if (STAROSTA_ACCOUNTS[username]) return 'starosta';
  if (userData && userData.role === 'starosta') return 'starosta';
  return 'user';
}

function isAdmin(username) {
  return ADMIN_USERNAMES.includes(username);
}

module.exports = { ADMIN_USERNAMES, STAROSTA_ACCOUNTS, getUserRole, isAdmin };
