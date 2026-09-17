const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  listarProductos,
  obtenerPorCodigo,
  crearProducto,
  editarProducto,
  desactivarProducto,
  ajustarStock,
  subirImagenProducto,
  listarCategorias
} = require('./productos.controller');
const upload = require('../../config/cloudinary');



router.get('/', verificarToken, listarProductos);
router.get('/codigo/:codigo', verificarToken, obtenerPorCodigo);
router.post('/', verificarToken, verificarRol('admin'), crearProducto);
router.put('/:id', verificarToken, verificarRol('admin'), editarProducto);
router.patch('/:id/desactivar', verificarToken, verificarRol('admin'), desactivarProducto);
router.patch('/:id/stock', verificarToken, verificarRol('admin'), ajustarStock);
router.post('/subir-imagen', verificarToken, verificarRol('admin'), upload.single('imagen'), subirImagenProducto);
router.get('/categorias', verificarToken, listarCategorias);

module.exports = router;