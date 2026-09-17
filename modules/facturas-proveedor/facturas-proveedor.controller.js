const pool = require('../../config/db');
const { convertirAUSD, convertirEntreMonedas } = require('../../utils/conversionMoneda');

async function crearFactura(req, res) {
  const { proveedor_nombre, numero_factura, descripcion, monto_original, moneda_original, fecha_emision, fecha_vencimiento } = req.body;
  const usuario_id = req.usuario.id;

  if (!proveedor_nombre || monto_original == null || !moneda_original) {
    return res.status(400).json({ message: 'proveedor_nombre, monto_original y moneda_original son requeridos' });
  }

  try {
    const tasaResultado = await pool.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (tasaResultado.rows.length === 0) {
      return res.status(400).json({ message: 'No hay tasa de cambio registrada' });
    }
    const tasa = tasaResultado.rows[0];
    const montoUsd = convertirAUSD(monto_original, moneda_original, tasa);

    const resultado = await pool.query(
      `INSERT INTO facturas_proveedor (
        proveedor_nombre, numero_factura, descripcion, monto_original, moneda_original,
        monto_usd, saldo_pendiente_original, fecha_emision, fecha_vencimiento, usuario_id
      )
       VALUES ($1, $2, $3, $4, $5, $6, $4, COALESCE($7, CURRENT_DATE), $8, $9)
       RETURNING *`,
      [
        proveedor_nombre, numero_factura || null, descripcion || null, monto_original, moneda_original,
        montoUsd, fecha_emision || null, fecha_vencimiento || null, usuario_id
      ]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear factura', error: error.message });
  }
}

async function listarFacturas(req, res) {
  const { estado, desde, hasta } = req.query;
  try {
    let query = `
      SELECT fp.*, u.nombre AS creado_por,
        CASE
          WHEN fp.estado = 'pendiente' AND fp.fecha_vencimiento IS NOT NULL AND fp.fecha_vencimiento < CURRENT_DATE
          THEN 'vencida'
          ELSE fp.estado::text
        END AS estado_efectivo
      FROM facturas_proveedor fp
      JOIN usuarios u ON u.id = fp.usuario_id
      WHERE 1=1
    `;
    const params = [];

    if (estado) {
      params.push(estado);
      query += ` AND (
        CASE
          WHEN fp.estado = 'pendiente' AND fp.fecha_vencimiento IS NOT NULL AND fp.fecha_vencimiento < CURRENT_DATE
          THEN 'vencida'
          ELSE fp.estado::text
        END
      ) = $${params.length}`;
    }
    if (desde) {
      params.push(desde);
      query += ` AND fp.fecha_emision >= $${params.length}`;
    }
    if (hasta) {
      params.push(hasta);
      query += ` AND fp.fecha_emision <= $${params.length}`;
    }

    query += ` ORDER BY fp.fecha_vencimiento ASC NULLS LAST, fp.fecha_emision DESC`;

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar facturas', error: error.message });
  }
}

async function obtenerFacturaPorId(req, res) {
  const { id } = req.params;
  try {
    const facturaResultado = await pool.query('SELECT * FROM facturas_proveedor WHERE id = $1', [id]);
    if (facturaResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }
    const pagos = await pool.query(
      `SELECT pf.*, mp.nombre AS metodo_nombre
       FROM pagos_factura_proveedor pf
       LEFT JOIN metodos_pago mp ON mp.id = pf.metodo_pago_id
       WHERE pf.factura_id = $1
       ORDER BY pf.fecha DESC`,
      [id]
    );
    res.json({ factura: facturaResultado.rows[0], pagos: pagos.rows });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener factura', error: error.message });
  }
}

async function registrarPagoFactura(req, res) {
  const { factura_id, monto, moneda, metodo_pago_id, referencia, sesion_caja_id } = req.body;
  const usuario_id = req.usuario.id;

  if (!factura_id || monto == null || !moneda) {
    return res.status(400).json({ message: 'factura_id, monto y moneda son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const facturaResultado = await client.query('SELECT * FROM facturas_proveedor WHERE id = $1 FOR UPDATE', [factura_id]);
    if (facturaResultado.rows.length === 0) {
      throw new Error('Factura no encontrada');
    }
    const factura = facturaResultado.rows[0];

    if (factura.estado === 'anulada') {
      throw new Error('No se puede pagar una factura anulada');
    }

    const tasaResultado = await client.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (tasaResultado.rows.length === 0) {
      throw new Error('No hay tasa de cambio registrada');
    }
    const tasa = tasaResultado.rows[0];

    const montoEnMonedaFactura = convertirEntreMonedas(monto, moneda, factura.moneda_original, tasa);
    const montoUsd = convertirAUSD(monto, moneda, tasa);

    const nuevoSaldo = Math.max(0, Number(factura.saldo_pendiente_original) - montoEnMonedaFactura);
    const nuevoEstado = nuevoSaldo <= 0.01 ? 'pagada' : 'pendiente';

    await client.query(
      `UPDATE facturas_proveedor SET saldo_pendiente_original = $1, estado = $2 WHERE id = $3`,
      [nuevoSaldo, nuevoEstado, factura_id]
    );

    const pagoResultado = await client.query(
      `INSERT INTO pagos_factura_proveedor (factura_id, monto, moneda, monto_usd, metodo_pago_id, referencia, sesion_caja_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [factura_id, monto, moneda, montoUsd, metodo_pago_id || null, referencia || null, sesion_caja_id || null, usuario_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ pago: pagoResultado.rows[0], saldo_pendiente: nuevoSaldo, estado: nuevoEstado });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function anularFactura(req, res) {
  const { id } = req.params;
  try {
    const resultado = await pool.query(
      `UPDATE facturas_proveedor SET estado = 'anulada' WHERE id = $1 RETURNING *`,
      [id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al anular factura', error: error.message });
  }
}

async function resumenFacturas(req, res) {
  try {
    const pendientesPorMoneda = await pool.query(
      `SELECT moneda_original AS moneda, COALESCE(SUM(saldo_pendiente_original), 0) AS total_pendiente
       FROM facturas_proveedor
       WHERE estado = 'pendiente'
       GROUP BY moneda_original`
    );
    const vencidas = await pool.query(
      `SELECT COUNT(*) AS cantidad FROM facturas_proveedor
       WHERE estado = 'pendiente' AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento < CURRENT_DATE`
    );
    res.json({
      pendientes_por_moneda: pendientesPorMoneda.rows,
      facturas_vencidas: Number(vencidas.rows[0].cantidad)
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen de facturas', error: error.message });
  }
}

module.exports = { crearFactura, listarFacturas, obtenerFacturaPorId, registrarPagoFactura, anularFactura, resumenFacturas };