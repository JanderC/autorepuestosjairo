const pool = require('../../config/db');
const generarCodigoProducto = require('../../utils/generarCodigo');
const { calcularPreciosYGanancia } = require('../../utils/calculoGanancia');

async function listarProductos(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM productos WHERE activo = true ORDER BY nombre ASC'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar productos', error: error.message });
  }
}

async function obtenerPorCodigo(req, res) {
  const { codigo } = req.params;
  try {
    const resultado = await pool.query(
      'SELECT * FROM productos WHERE codigo = $1 AND activo = true',
      [codigo]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar producto', error: error.message });
  }
}

async function listarCategorias(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT DISTINCT categoria FROM productos WHERE categoria IS NOT NULL AND activo = true ORDER BY categoria ASC`
    );
    res.json(resultado.rows.map((r) => r.categoria));
  } catch (error) {
    res.status(500).json({ message: 'Error al listar categorías', error: error.message });
  }
}

async function crearProducto(req, res) {
  const {
    codigo, nombre, descripcion, precio_compra, precio_venta,
    porcentaje_ganancia, moneda_base, categoria, stock, imagen_url,
    precio_manual_usd, precio_manual_cop, precio_manual_bs
  } = req.body;

  if (!nombre || precio_compra == null || !moneda_base) {
    return res.status(400).json({ message: 'Nombre, precio de compra y moneda base son requeridos' });
  }

  if (!['USD', 'COP', 'BS'].includes(moneda_base)) {
    return res.status(400).json({ message: 'Moneda base inválida' });
  }

  if (porcentaje_ganancia == null && precio_venta == null) {
    return res.status(400).json({ message: 'Debes indicar el precio de venta o un porcentaje de ganancia' });
  }

  const { precio_venta: ventaFinal, porcentaje_ganancia: porcentajeFinal } = calcularPreciosYGanancia({
    precio_compra, precio_venta, porcentaje_ganancia
  });

  const codigoFinal = codigo && codigo.trim() !== '' ? codigo.trim() : generarCodigoProducto();

  try {
    const existente = await pool.query('SELECT id FROM productos WHERE codigo = $1', [codigoFinal]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya existe un producto con ese código' });
    }

    const resultado = await pool.query(
      `INSERT INTO productos (
        codigo, nombre, descripcion, precio_compra, precio_venta, porcentaje_ganancia,
        moneda_base, categoria, stock, imagen_url,
        precio_manual_usd, precio_manual_cop, precio_manual_bs
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        codigoFinal, nombre, descripcion || null, precio_compra, ventaFinal, porcentajeFinal,
        moneda_base, categoria || null, stock || 0, imagen_url || null,
        precio_manual_usd || null, precio_manual_cop || null, precio_manual_bs || null
      ]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear producto', error: error.message });
  }
}

async function editarProducto(req, res) {
  const { id } = req.params;
  const {
    nombre, descripcion, precio_compra, precio_venta,
    porcentaje_ganancia, moneda_base, categoria, imagen_url,
    precio_manual_usd, precio_manual_cop, precio_manual_bs
  } = req.body;

  try {
    const actualResultado = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
    if (actualResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    const actual = actualResultado.rows[0];

    const compraFinal = precio_compra != null ? precio_compra : actual.precio_compra;

    let ventaFinal = actual.precio_venta;
    let porcentajeFinal = actual.porcentaje_ganancia;

    if (precio_compra != null || precio_venta != null || porcentaje_ganancia != null) {
      const calculado = calcularPreciosYGanancia({
        precio_compra: compraFinal,
        precio_venta: precio_venta != null ? precio_venta : actual.precio_venta,
        porcentaje_ganancia: porcentaje_ganancia
      });
      ventaFinal = calculado.precio_venta;
      porcentajeFinal = calculado.porcentaje_ganancia;
    }

    const manualUsdFinal = precio_manual_usd !== undefined ? (precio_manual_usd === '' ? null : precio_manual_usd) : actual.precio_manual_usd;
    const manualCopFinal = precio_manual_cop !== undefined ? (precio_manual_cop === '' ? null : precio_manual_cop) : actual.precio_manual_cop;
    const manualBsFinal = precio_manual_bs !== undefined ? (precio_manual_bs === '' ? null : precio_manual_bs) : actual.precio_manual_bs;

    const resultado = await pool.query(
      `UPDATE productos SET
        nombre = COALESCE($1, nombre),
        descripcion = COALESCE($2, descripcion),
        precio_compra = $3,
        precio_venta = $4,
        porcentaje_ganancia = $5,
        moneda_base = COALESCE($6, moneda_base),
        categoria = COALESCE($7, categoria),
        imagen_url = COALESCE($8, imagen_url),
        precio_manual_usd = $9,
        precio_manual_cop = $10,
        precio_manual_bs = $11,
        updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [nombre, descripcion, compraFinal, ventaFinal, porcentajeFinal, moneda_base, categoria, imagen_url, manualUsdFinal, manualCopFinal, manualBsFinal, id]
    );

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al editar producto', error: error.message });
  }
}

async function desactivarProducto(req, res) {
  const { id } = req.params;
  try {
    const resultado = await pool.query(
      `UPDATE productos SET activo = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }
    res.json({ message: 'Producto desactivado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar producto', error: error.message });
  }
}

async function ajustarStock(req, res) {
  const { id } = req.params;
  const { cantidad } = req.body;

  if (cantidad == null) {
    return res.status(400).json({ message: 'Cantidad es requerida' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE productos SET stock = stock + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, nombre, stock`,
      [cantidad, id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al ajustar stock', error: error.message });
  }
}

async function subirImagenProducto(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'No se recibió ninguna imagen' });
  }
  try {
    res.json({ imagen_url: req.file.path });
  } catch (error) {
    res.status(500).json({ message: 'Error al subir imagen', error: error.message });
  }
}

module.exports = {
  listarProductos,
  obtenerPorCodigo,
  listarCategorias,
  crearProducto,
  editarProducto,
  desactivarProducto,
  ajustarStock,
  subirImagenProducto
};