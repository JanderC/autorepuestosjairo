const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  listarUsuarios,
  crearUsuario,
  editarUsuario,
  cambiarEstadoUsuario
} = require('./usuarios.controller');

router.get('/', verificarToken, verificarRol('admin'), listarUsuarios);
router.post('/', verificarToken, verificarRol('admin'), crearUsuario);
router.put('/:id', verificarToken, verificarRol('admin'), editarUsuario);
router.patch('/:id/estado', verificarToken, verificarRol('admin'), cambiarEstadoUsuario);

module.exports = router;