const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  resumenGeneral,
  productosMasVendidos,
  ventasPorMetodoPago,
  ventasPorMoneda,
  ventasDiarias,
  menorRotacion
} = require('./reportes.controller');

router.get('/resumen', verificarToken, verificarRol('admin'), resumenGeneral);
router.get('/productos-mas-vendidos', verificarToken, verificarRol('admin'), productosMasVendidos);
router.get('/ventas-por-metodo-pago', verificarToken, verificarRol('admin'), ventasPorMetodoPago);
router.get('/ventas-por-moneda', verificarToken, verificarRol('admin'), ventasPorMoneda);
router.get('/ventas-diarias', verificarToken, verificarRol('admin'), ventasDiarias);
router.get('/menor-rotacion', verificarToken, verificarRol('admin'), menorRotacion);

module.exports = router;