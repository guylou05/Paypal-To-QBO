const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const db       = require('../db/knex');
const config   = require('../config');
const { authenticate } = require('../middleware/auth');
const { handleValidation } = require('../middleware/validate');
const logger   = require('../utils/logger');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   config.env === 'production',
  sameSite: 'lax',
  maxAge:   8 * 60 * 60 * 1000, // 8 hours
};

// POST /api/auth/login
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 1 }),
  handleValidation,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await db('users').where({ email, is_active: true }).first();

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        await db('audit_logs').insert({
          action:     'login_failed',
          entity_type:'user',
          entity_id:  email,
          details:    'Invalid credentials',
          ip_address: req.ip,
          created_at: new Date(), updated_at: new Date(),
        });
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn }
      );

      await db('audit_logs').insert({
        user_id:    user.id,
        action:     'login',
        entity_type:'user',
        entity_id:  String(user.id),
        ip_address: req.ip,
        created_at: new Date(), updated_at: new Date(),
      });

      res.cookie('auth_token', token, COOKIE_OPTS);
      return res.json({ user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      logger.error('Login error', { error: err.message });
      return res.status(500).json({ error: 'Login failed' });
    }
  }
);

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  res.clearCookie('auth_token');
  return res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const user = await db('users').where({ id: req.user.id }).first();
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ id: user.id, email: user.email, role: user.role });
});

// POST /api/auth/change-password
router.post('/change-password',
  authenticate,
  body('currentPassword').isLength({ min: 1 }),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  handleValidation,
  async (req, res) => {
    const user = await db('users').where({ id: req.user.id }).first();
    const ok   = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(req.body.newPassword, 12);
    await db('users').where({ id: user.id }).update({ password_hash: hash, updated_at: new Date() });
    res.clearCookie('auth_token');
    return res.json({ message: 'Password changed. Please log in again.' });
  }
);

module.exports = router;
