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

// Busca ventas por el nombre del producto vendido — pensado para cuando no se tiene a mano
// el folio, que es difícil de recordar ("van a devolver una estopera de hace días").
async function buscarVentasPorProducto(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ message: 'Indicá al menos 2 caracteres para buscar' });
  }
  try {
    const resultado = await pool.query(
      `SELECT DISTINCT ON (v.id) v.id, v.numero_venta, v.fecha, v.estado,
              u.nombre AS vendedor, c.nombre AS cliente_nombre, p.nombre AS producto_nombre
       FROM detalle_venta dv
       JOIN ventas v ON v.id = dv.venta_id
       JOIN productos p ON p.id = dv.producto_id
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE p.nombre ILIKE $1 AND v.estado <> 'anulada'
       ORDER BY v.id, v.fecha DESC
       LIMIT 30`,
      [`%${q.trim()}%`]
    );
    resultado.rows.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar por producto', error: error.message });
  }
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
  const {
    venta_id, items, tipo_reembolso, moneda_reembolso, metodo_pago_id, motivo, cliente_id,
    monto_manual, direccion_efectivo
  } = req.body;
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

      // El monto puede ajustarse a mano (útil en cambios donde el valor no coincide exacto
      // con lo que dieron los productos seleccionados) — si no, se calcula automático.
      montoReembolso = monto_manual != null && monto_manual !== ''
        ? redondear(Number(monto_manual), 2)
        : redondear(convertirEntreMonedas(montoTotalOriginal, monedaOriginalVenta, monedaFinal, tasa), 2);
    }

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

    // Efectivo: puede ir en cualquiera de las dos direcciones.
    // 'egreso' = le devolvemos plata (sale de caja) — el caso normal de una devolución.
    // 'ingreso' = el cliente paga diferencia (entra a caja) — cuando cambia por algo más caro.
    if (tipoFinal === 'efectivo') {
      if (!metodo_pago_id) throw new Error('Indicá con qué método se movió el dinero');
      if (!sesionCajaId) throw new Error('No hay una caja abierta para registrar este movimiento');

      const direccion = direccion_efectivo === 'ingreso' ? 'ingreso' : 'egreso';
      const concepto = direccion === 'ingreso'
        ? `Cobro por cambio · venta ${venta.numero_venta}`
        : `Devolución venta ${venta.numero_venta}`;
      const montoUsd = convertirAUSD(montoReembolso, monedaFinal, tasa);

      await client.query(
        `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sesionCajaId, direccion, concepto, monedaFinal, montoReembolso, montoUsd, usuario_id]
      );
    }

    if (tipoFinal === 'fiado') {
      const montoUsd = convertirAUSD(montoReembolso, monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)`,
        [venta.cliente_id, monedaFinal, montoReembolso, montoUsd, venta_id, sesionCajaId, usuario_id, `Devolución venta ${venta.numero_venta}`]
      );
    }

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

module.exports = { obtenerVentaDevolvible, crearDevolucion, listarDevoluciones, buscarVentasPorProducto };