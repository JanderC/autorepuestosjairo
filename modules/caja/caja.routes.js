const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const {
  obtenerSesionAbierta,
  abrirCaja,
  registrarMovimiento,
  resumenSesion,
  cerrarCaja,
  listarHistorialSesiones,
  movimientosDelDia
} = require('./caja.controller');

router.get('/abierta', verificarToken, obtenerSesionAbierta);
router.post('/abrir', verificarToken, abrirCaja);
router.post('/movimiento', verificarToken, registrarMovimiento);
router.get('/:id/resumen', verificarToken, resumenSesion);
router.post('/:id/cerrar', verificarToken, cerrarCaja);
router.get('/historial', verificarToken, listarHistorialSesiones);
router.get('/:id/movimientos-dia', verificarToken, movimientosDelDia);

module.exports = router;