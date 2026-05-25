const express = require('express');
const router  = express.Router();

router.use('/auth',         require('./auth'));
router.use('/paypal',       require('./paypal'));
router.use('/quickbooks',   require('./quickbooks'));
router.use('/transactions', require('./transactions'));
router.use('/settings',     require('./settings'));
router.use('/reports',      require('./reports'));
router.use('/logs',         require('./logs'));

router.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

module.exports = router;
