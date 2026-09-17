const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const { crearColaboracion, listarColaboraciones, resumenColaboraciones } = require('./colaboraciones.controller');

router.get('/resumen', verificarToken, verificarRol('admin'), resumenColaboraciones);
router.post('/', verificarToken, verificarRol('admin'), crearColaboracion);
router.get('/', verificarToken, verificarRol('admin'), listarColaboraciones);

module.exports = router;