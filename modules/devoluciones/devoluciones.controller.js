const pool = require('../../config/db');
const { convertirAUSD, convertirEntreMonedas, redondear } = require('../../utils/conversionMoneda');

async function obtenerCantidadesDevueltas(ejecutor, ventaId) {
  const resultado = await ejecutor.query(
    `SELECT dd.producto_id, COALESCE(SUM(dd.cantidad), 0) AS cantidad_devuelta
     FROM detalle_devolucion dd
     JOIN devoluciones d ON d.id = dd.devolucion_id
     WHERE d.venta_id = $1
     GROUP BY dd.producto_id`,
    [ventaId]
  );
  const mapa = {};
  resultado.rows.forEach((r) => { mapa[r.producto_id] = Number(r.cantidad_devuelta); });
  return mapa;
}

async function obtenerVentaDevolvible(req, res) {
  const { ventaId } = req.params;
  try {
    const ventaResultado = await pool.query('SELECT * FROM ventas WHERE id = $1', [ventaId]);
    if (ventaResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Venta no encontrada' });
    }
    const venta = ventaResultado.rows[0];
    if (venta.estado === 'anulada') {
      return res.status(400).json({ message: 'Esta venta está anulada, no se puede devolver' });
    }

    const detalles = await pool.query(
      `SELECT dv.*, p.nombre, p.codigo
       FROM detalle_venta dv JOIN productos p ON p.id = dv.producto_id
       WHERE dv.venta_id = $1`,
      [ventaId]
    );
    const cantidadesDevueltas = await obtenerCantidadesDevueltas(pool, ventaId);

    const items = detalles.rows.map((d) => ({
      ...d,
      cantidad_devuelta: cantidadesDevueltas[d.producto_id] || 0,
      cantidad_disponible: d.cantidad - (cantidadesDevueltas[d.producto_id] || 0),
    }));

    let fiado = null;
    if (venta.cliente_id) {
      const fiadoResultado = await pool.query(
        `SELECT * FROM movimientos_cuenta WHERE venta_id = $1 AND tipo = 'cargo'`,
        [ventaId]
      );
      fiado = fiadoResultado.rows[0] || null;
    }

    res.json({ venta, items, fiado });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la venta', error: error.message });
  }
}

async function crearDevolucion(req, res) {
  const { venta_id, items, tipo_reembolso, moneda_reembolso, metodo_pago_id, motivo, cliente_id } = req.body;
  const usuario_id = req.usuario.id;

  if (!venta_id || !items || items.length === 0) {
    return res.status(400).json({ message: 'venta_id e items son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ventaResultado = await client.query('SELECT * FROM ventas WHERE id = $1 FOR UPDATE', [venta_id]);
    if (ventaResultado.rows.length === 0) throw new Error('Venta no encontrada');
    const venta = ventaResultado.rows[0];
    if (venta.estado === 'anulada') throw new Error('No se puede devolver una venta anulada');

    const detallesVenta = await client.query('SELECT * FROM detalle_venta WHERE venta_id = $1', [venta_id]);
    const detallesPorProducto = {};
    detallesVenta.rows.forEach((d) => { detallesPorProducto[d.producto_id] = d; });

    const cantidadesDevueltas = await obtenerCantidadesDevueltas(client, venta_id);

    const sesionResultado = await client.query(
      `SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`
    );
    const sesionCajaId = sesionResultado.rows[0]?.id || null;

    let montoTotalOriginal = 0;
    let monedaOriginalVenta = null;
    const detallesDevolucion = [];

    for (const item of items) {
      const detalleOriginal = detallesPorProducto[item.producto_id];
      if (!detalleOriginal) throw new Error(`El producto ${item.producto_id} no pertenece a esta venta`);

      const yaDevuelto = cantidadesDevueltas[item.producto_id] || 0;
      const disponible = detalleOriginal.cantidad - yaDevuelto;
      const cantidad = Number(item.cantidad) || 0;
      if (cantidad <= 0) continue;
      if (cantidad > disponible) {
        throw new Error(`Solo quedan ${disponible} unidad(es) disponibles para devolver de ese producto`);
      }

      const precioUnitario = Number(detalleOriginal.precio_unitario_original);
      const subtotal = redondear(precioUnitario * cantidad, 2);
      monedaOriginalVenta = detalleOriginal.moneda_original;
      montoTotalOriginal = redondear(montoTotalOriginal + subtotal, 2);

      detallesDevolucion.push({
        producto_id: item.producto_id,
        cantidad,
        precio_unitario_original: precioUnitario,
        subtotal_original: subtotal,
        moneda_original: detalleOriginal.moneda_original,
      });

      await client.query(
        'UPDATE productos SET stock = stock + $1, updated_at = NOW() WHERE id = $2',
        [cantidad, item.producto_id]
      );
    }

    if (detallesDevolucion.length === 0) throw new Error('No hay productos para devolver');

    const tipoFinal = tipo_reembolso || 'ninguno';
    const monedaFinal = moneda_reembolso || monedaOriginalVenta;
    let montoReembolso = 0;
    let tasa = null;

    if (tipoFinal !== 'ninguno') {
      const tasaResultado = await client.query(
        'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
      );
      if (tasaResultado.rows.length === 0) throw new Error('No hay tasa de cambio registrada');
      tasa = tasaResultado.rows[0];
      montoReembolso = redondear(
        convertirEntreMonedas(montoTotalOriginal, monedaOriginalVenta, monedaFinal, tasa),
        2
      );
    }

    // A quién se le acredita el saldo a favor: si la venta ya tenía cliente, es ese;
    // si fue una venta sin cliente (mostrador), el cajero elige uno en el momento.
    let clienteDestinoCredito = null;
    if (tipoFinal === 'fiado' && !venta.cliente_id) {
      throw new Error('Esta venta no tiene cliente asociado para reducir el fiado');
    }
    if (tipoFinal === 'credito') {
      clienteDestinoCredito = venta.cliente_id || cliente_id || null;
      if (!clienteDestinoCredito) {
        throw new Error('Elegí a qué cliente guardarle el saldo a favor');
      }
    }

    const devolucionResultado = await client.query(
      `INSERT INTO devoluciones (venta_id, tipo_reembolso, monto_reembolsado, moneda_reembolso, motivo, sesion_caja_id, usuario_id, cliente_credito_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        venta_id, tipoFinal, montoReembolso, tipoFinal !== 'ninguno' ? monedaFinal : null,
        motivo || null, sesionCajaId, usuario_id,
        tipoFinal === 'credito' && !venta.cliente_id ? clienteDestinoCredito : null
      ]
    );
    const devolucion = devolucionResultado.rows[0];

    for (const d of detallesDevolucion) {
      await client.query(
        `INSERT INTO detalle_devolucion (devolucion_id, producto_id, cantidad, precio_unitario_original, subtotal_original, moneda_original)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [devolucion.id, d.producto_id, d.cantidad, d.precio_unitario_original, d.subtotal_original, d.moneda_original]
      );
    }

    // Efectivo devuelto: egreso de caja — reutiliza toda la lógica que ya suma/resta
    // movimientos en Punto de Venta y en el cuadre de cierre.
    if (tipoFinal === 'efectivo') {
      if (!metodo_pago_id) throw new Error('Indicá con qué método se le devolvió el dinero');
      if (!sesionCajaId) throw new Error('No hay una caja abierta para registrar la devolución en efectivo');

      const montoUsd = convertirAUSD(montoReembolso, monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
         VALUES ($1, 'egreso', $2, $3, $4, $5, $6)`,
        [sesionCajaId, `Devolución venta ${venta.numero_venta}`, monedaFinal, montoReembolso, montoUsd, usuario_id]
      );
    }

    // Reduce fiado existente: mismo mecanismo que un abono, sin mover efectivo real.
    if (tipoFinal === 'fiado') {
      const montoUsd = convertirAUSD(montoReembolso, monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)`,
        [venta.cliente_id, monedaFinal, montoReembolso, montoUsd, venta_id, sesionCajaId, usuario_id, `Devolución venta ${venta.numero_venta}`]
      );
    }

    // Saldo a favor: un 'abono' sin deuda que lo cubra dejando el saldo en negativo — eso ES
    // el crédito. No toca movimientos_caja, así que la caja del día queda intacta.
    if (tipoFinal === 'credito') {
      const montoUsd = convertirAUSD(montoReembolso, monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)`,
        [clienteDestinoCredito, monedaFinal, montoReembolso, montoUsd, venta_id, sesionCajaId, usuario_id, `Saldo a favor por devolución ${venta.numero_venta}`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      devolucion,
      detalles: detallesDevolucion,
      monto_reembolsado: montoReembolso,
      moneda_reembolso: tipoFinal !== 'ninguno' ? monedaFinal : null,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function listarDevoluciones(req, res) {
  try {
    const resultado = await pool.query(`
      SELECT d.*, v.numero_venta, u.nombre AS usuario_nombre,
        (
          SELECT json_agg(json_build_object(
            'producto_nombre', p.nombre, 'cantidad', dd.cantidad,
            'subtotal_original', dd.subtotal_original, 'moneda_original', dd.moneda_original
          ))
          FROM detalle_devolucion dd JOIN productos p ON p.id = dd.producto_id
          WHERE dd.devolucion_id = d.id
        ) AS items
      FROM devoluciones d
      JOIN ventas v ON v.id = d.venta_id
      JOIN usuarios u ON u.id = d.usuario_id
      ORDER BY d.fecha DESC
    `);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar devoluciones', error: error.message });
  }
}

module.exports = { obtenerVentaDevolvible, crearDevolucion, listarDevoluciones };