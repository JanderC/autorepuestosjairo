const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const { listarMetodosPago, crearMetodoPago, desactivarMetodoPago } = require('./metodos-pago.controller');

router.get('/', verificarToken, listarMetodosPago);
router.post('/', verificarToken, verificarRol('admin'), crearMetodoPago);
router.patch('/:id/desactivar', verificarToken, verificarRol('admin'), desactivarMetodoPago);

module.exports = router;