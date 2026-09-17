const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  crearFactura,
  listarFacturas,
  obtenerFacturaPorId,
  registrarPagoFactura,
  anularFactura,
  resumenFacturas
} = require('./facturas-proveedor.controller');

router.get('/resumen', verificarToken, verificarRol('admin'), resumenFacturas);
router.get('/', verificarToken, verificarRol('admin'), listarFacturas);
router.post('/', verificarToken, verificarRol('admin'), crearFactura);
router.get('/:id', verificarToken, verificarRol('admin'), obtenerFacturaPorId);
router.post('/pago', verificarToken, verificarRol('admin'), registrarPagoFactura);
router.patch('/:id/anular', verificarToken, verificarRol('admin'), anularFactura);

module.exports = router;