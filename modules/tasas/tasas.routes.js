const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  obtenerTasaActual,
  listarHistorial,
  registrarTasaManual,
  actualizarTasaAutomatica,
  actualizarBsCopManual,
  restablecerBsCop
} = require('./tasas.controller');

router.get('/actual', verificarToken, obtenerTasaActual);
router.get('/historial', verificarToken, verificarRol('admin'), listarHistorial);
router.post('/manual', verificarToken, verificarRol('admin'), registrarTasaManual);
router.post('/actualizar', verificarToken, verificarRol('admin'), actualizarTasaAutomatica);
router.patch('/actual/bs-cop', verificarToken, verificarRol('admin'), actualizarBsCopManual);
router.patch('/actual/bs-cop/restablecer', verificarToken, verificarRol('admin'), restablecerBsCop);

module.exports = router;