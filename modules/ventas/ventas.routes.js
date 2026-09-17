const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const { crearVenta, listarVentas, obtenerVentaPorId } = require('./ventas.controller');

router.post('/', verificarToken, crearVenta);
router.get('/', verificarToken, listarVentas);
router.get('/:id', verificarToken, obtenerVentaPorId);

module.exports = router;