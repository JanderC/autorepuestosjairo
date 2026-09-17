const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const { listarPendientes, registrarMovimiento, cerrarCuenta, listarHistorial, detalleCierre } = require('./consignaciones.controller');

router.get('/cliente/:clienteId/pendientes', verificarToken, listarPendientes);
router.get('/cliente/:clienteId/historial', verificarToken, listarHistorial);
router.get('/cierre/:cierreId/detalle', verificarToken, detalleCierre);
router.post('/movimiento', verificarToken, registrarMovimiento);
router.post('/cerrar', verificarToken, verificarRol('admin'), cerrarCuenta);

module.exports = router;