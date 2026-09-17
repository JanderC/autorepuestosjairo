const pool = require('../../config/db');
const { convertirEntreMonedas } = require('../../utils/conversionMoneda');

const MONEDAS_VALIDAS = ['USD', 'COP', 'BS'];

async function crearColaboracion(req, res) {
  const { producto_id, cantidad, receptor, motivo, moneda } = req.body;
  const usuario_id = req.usuario.id;

  if (!producto_id || !cantidad) {
    return res.status(400).json({ message: 'producto_id y cantidad son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const productoResultado = await client.query(
      'SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE',
      [producto_id]
    );
    if (productoResultado.rows.length === 0) {
      throw new Error('Producto no encontrado');
    }
    const producto = productoResultado.rows[0];

    if (producto.stock < cantidad) {
      throw new Error(`Stock insuficiente (disponible: ${producto.stock})`);
    }

    // Moneda en la que se valoriza esta colaboración puntual — elegida por el admin,
    // no tiene por qué ser la moneda base del producto.
    const monedaElegida = moneda || producto.moneda_base;
    if (!MONEDAS_VALIDAS.includes(monedaElegida)) {
      throw new Error('Moneda inválida');
    }

    let costoUnitario = Number(producto.precio_compra);
    if (monedaElegida !== producto.moneda_base) {
      const tasaResultado = await client.query(
        'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
      );
      if (tasaResultado.rows.length === 0) {
        throw new Error('No hay tasa de cambio registrada');
      }
      const tasa = tasaResultado.rows[0];
      costoUnitario = convertirEntreMonedas(producto.precio_compra, producto.moneda_base, monedaElegida, tasa);
    }

    // La sesión de caja se resuelve acá, igual que en ventas y abonos, para no depender
    // de un dato desactualizado que traiga el frontend.
    const sesionResultado = await client.query(
      `SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`
    );
    const sesionCajaResuelta = sesionResultado.rows[0]?.id || null;

    await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [cantidad, producto.id]);

    const resultado = await client.query(
      `INSERT INTO colaboraciones (producto_id, cantidad, costo_unitario_original, moneda_original, receptor, motivo, sesion_caja_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [producto.id, cantidad, costoUnitario, monedaElegida, receptor || null, motivo || null, sesionCajaResuelta, usuario_id]
    );

    await client.query('COMMIT');
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function listarColaboraciones(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT col.*, p.nombre AS producto_nombre, p.moneda_base, p.precio_compra, u.nombre AS usuario_nombre
       FROM colaboraciones col
       JOIN productos p ON p.id = col.producto_id
       JOIN usuarios u ON u.id = col.usuario_id
       ORDER BY col.fecha DESC`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar colaboraciones', error: error.message });
  }
}

async function resumenColaboraciones(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT moneda_original AS moneda, COUNT(*) AS cantidad_registros, SUM(cantidad) AS unidades_totales,
              SUM(cantidad * costo_unitario_original) AS costo_total
       FROM colaboraciones
       GROUP BY moneda_original`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen de colaboraciones', error: error.message });
  }
}

module.exports = { crearColaboracion, listarColaboraciones, resumenColaboraciones };