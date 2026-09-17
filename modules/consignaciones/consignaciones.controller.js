const pool = require('../../config/db');
const { convertirAUSD, convertirEntreMonedas, precioEfectivoEnMoneda, redondear } = require('../../utils/conversionMoneda');

async function listarPendientes(req, res) {
  const { clienteId } = req.params;
  try {
    const resultado = await pool.query(
      `SELECT mc.*, p.nombre AS producto_nombre, p.codigo
       FROM movimientos_consignacion mc
       JOIN productos p ON p.id = mc.producto_id
       WHERE mc.cliente_id = $1 AND mc.cierre_id IS NULL
       ORDER BY mc.fecha ASC`,
      [clienteId]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar movimientos pendientes', error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  const { cliente_id, producto_id, cantidad, tipo, moneda } = req.body;
  const usuario_id = req.usuario.id;

  if (!cliente_id || !producto_id || !cantidad || !['salida', 'devolucion'].includes(tipo)) {
    return res.status(400).json({ message: 'cliente_id, producto_id, cantidad y tipo son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const productoResultado = await client.query('SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE', [producto_id]);
    if (productoResultado.rows.length === 0) throw new Error('Producto no encontrado');
    const producto = productoResultado.rows[0];

    if (tipo === 'salida' && producto.stock < cantidad) {
      throw new Error(`Stock insuficiente (disponible: ${producto.stock})`);
    }

    const tasaResultado = await client.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (tasaResultado.rows.length === 0) throw new Error('No hay tasa de cambio registrada');
    const tasa = tasaResultado.rows[0];

    const monedaElegida = moneda || producto.moneda_base;
    const precioUnitario = precioEfectivoEnMoneda(producto, monedaElegida, tasa);

    const ajusteStock = tipo === 'salida' ? -cantidad : cantidad;
    await client.query('UPDATE productos SET stock = stock + $1, updated_at = NOW() WHERE id = $2', [ajusteStock, producto_id]);

    const resultado = await client.query(
      `INSERT INTO movimientos_consignacion (cliente_id, producto_id, tipo, cantidad, precio_unitario_original, moneda_original, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [cliente_id, producto_id, tipo, cantidad, precioUnitario, monedaElegida, usuario_id]
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

// Cierra todo lo pendiente de un cliente: convierte cada movimiento a una sola moneda,
// aplica el descuento, y reparte el total entre "pagado ahora" (ingreso de caja, si aplica)
// y "queda fiado" (cargo en movimientos_cuenta) — sin tocar caja para nada de lo ya registrado
// durante la semana, solo para el pago que efectivamente ocurre hoy.
async function cerrarCuenta(req, res) {
  const { cliente_id, moneda_cierre, descuento_porcentaje, monto_pagado, metodo_pago_id } = req.body;
  const usuario_id = req.usuario.id;

  if (!cliente_id || !moneda_cierre) {
    return res.status(400).json({ message: 'cliente_id y moneda_cierre son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pendientes = await client.query(
      `SELECT * FROM movimientos_consignacion WHERE cliente_id = $1 AND cierre_id IS NULL FOR UPDATE`,
      [cliente_id]
    );
    if (pendientes.rows.length === 0) throw new Error('No hay movimientos pendientes para cerrar');

    const tasaResultado = await client.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (tasaResultado.rows.length === 0) throw new Error('No hay tasa de cambio registrada');
    const tasa = tasaResultado.rows[0];

    let subtotal = 0;
    for (const m of pendientes.rows) {
      const monto = convertirEntreMonedas(Number(m.precio_unitario_original) * m.cantidad, m.moneda_original, moneda_cierre, tasa);
      subtotal += m.tipo === 'salida' ? monto : -monto;
    }
    subtotal = redondear(subtotal, 2);

    const descuentoPct = descuento_porcentaje != null ? Number(descuento_porcentaje) : 10;
    const total = redondear(subtotal - (subtotal * descuentoPct) / 100, 2);

    const sesionResultado = await client.query(`SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`);
    const sesionCajaId = sesionResultado.rows[0]?.id || null;

    const montoPagadoFinal = Math.max(0, Math.min(Number(monto_pagado) || 0, total));

    const cierreResultado = await client.query(
      `INSERT INTO consignaciones_cierre (cliente_id, subtotal_original, descuento_porcentaje, total_original, moneda_original, monto_pagado, metodo_pago_id, sesion_caja_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [cliente_id, subtotal, descuentoPct, total, moneda_cierre, montoPagadoFinal, montoPagadoFinal > 0 ? metodo_pago_id || null : null, sesionCajaId, usuario_id]
    );
    const cierre = cierreResultado.rows[0];

    await client.query(
      `UPDATE movimientos_consignacion SET cierre_id = $1 WHERE cliente_id = $2 AND cierre_id IS NULL`,
      [cierre.id, cliente_id]
    );

    if (montoPagadoFinal > 0) {
      const montoUsd = convertirAUSD(montoPagadoFinal, moneda_cierre, tasa);
      await client.query(
        `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
         VALUES ($1, 'ingreso', $2, $3, $4, $5, $6)`,
        [sesionCajaId, `Cierre semanal consignación · cliente #${cliente_id}`, moneda_cierre, montoPagadoFinal, montoUsd, usuario_id]
      );
    }

    const saldoPendiente = redondear(total - montoPagadoFinal, 2);
    if (saldoPendiente > 0.01) {
      const montoUsd = convertirAUSD(saldoPendiente, moneda_cierre, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'cargo', $2, $3, $4, $5, $6, $7)`,
        [cliente_id, moneda_cierre, saldoPendiente, montoUsd, sesionCajaId, usuario_id, `Cierre semanal de consignación (${descuentoPct}% dto.)`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ cierre, saldo_pendiente: saldoPendiente });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function listarHistorial(req, res) {
  const { clienteId } = req.params;
  try {
    const resultado = await pool.query(
      `SELECT cc.*, u.nombre AS usuario_nombre
       FROM consignaciones_cierre cc JOIN usuarios u ON u.id = cc.usuario_id
       WHERE cc.cliente_id = $1
       ORDER BY cc.fecha_cierre DESC`,
      [clienteId]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar historial', error: error.message });
  }
}

async function detalleCierre(req, res) {
  const { cierreId } = req.params;
  try {
    const movimientos = await pool.query(
      `SELECT mc.*, p.nombre AS producto_nombre
       FROM movimientos_consignacion mc JOIN productos p ON p.id = mc.producto_id
       WHERE mc.cierre_id = $1
       ORDER BY mc.fecha ASC`,
      [cierreId]
    );
    res.json(movimientos.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener detalle del cierre', error: error.message });
  }
}

module.exports = { listarPendientes, registrarMovimiento, cerrarCuenta, listarHistorial, detalleCierre };