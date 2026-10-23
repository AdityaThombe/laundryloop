'use strict';
// Vercel function: every /api/* request is rewritten here (see vercel.json).
const { handleApi } = require('../app');

module.exports = (req, res) => handleApi(req, res);
