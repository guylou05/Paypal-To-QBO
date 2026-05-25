const jwt    = require('jsonwebtoken');
const config = require('../config');

/**
 * Reads the JWT from the Authorization header (Bearer) OR from the
 * httpOnly cookie set at login. Cookie wins if both present.
 */
function authenticate(req, res, next) {
  let token = null;

  // Cookie first (preferred — httpOnly, not accessible by JS)
  if (req.cookies && req.cookies.auth_token) {
    token = req.cookies.auth_token;
  }

  // Fallback: Authorization: Bearer <token>
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

module.exports = { authenticate, requireAdmin };
