const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const { obtenerVentaDevolvible, crearDevolucion, listarDevoluciones } = require('./devoluciones.controller');

router.get('/venta/:ventaId', verificarToken, obtenerVentaDevolvible);
router.post('/', verificarToken, crearDevolucion);
router.get('/', verificarToken, listarDevoluciones);

module.exports = router;