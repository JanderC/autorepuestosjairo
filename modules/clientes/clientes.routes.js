const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const {
  listarClientes,
  buscarClientes,
  crearCliente,
  obtenerEstadoCuenta,
  registrarAbono,
  listarFiadosPendientes,
  resumenFiados
} = require('./clientes.controller');

router.get('/fiados/pendientes', verificarToken, listarFiadosPendientes);
router.get('/fiados/resumen', verificarToken, resumenFiados);
router.get('/', verificarToken, listarClientes);
router.get('/buscar', verificarToken, buscarClientes);
router.post('/', verificarToken, crearCliente);
router.get('/:id/estado-cuenta', verificarToken, obtenerEstadoCuenta);
router.post('/abono', verificarToken, registrarAbono);

module.exports = router;