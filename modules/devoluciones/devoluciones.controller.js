const pool = require('../../config/db');
const { convertirAUSD, convertirEntreMonedas, precioEfectivoEnMoneda, redondear } = require('../../utils/conversionMoneda');

async function obtenerCantidadesDevueltas(ejecutor, ventaId) {
  const resultado = await ejecutor.query(
    `SELECT dd.producto_id, COALESCE(SUM(dd.cantidad), 0) AS cantidad_devuelta
     FROM detalle_devolucion dd
     JOIN devoluciones d ON d.id = dd.devolucion_id
     WHERE d.venta_id = $1 AND dd.tipo_item = 'devuelto'
     GROUP BY dd.producto_id`,
    [ventaId]
  );
  const mapa = {};
  resultado.rows.forEach((r) => { mapa[r.producto_id] = Number(r.cantidad_devuelta); });
  return mapa;
}

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
    venta_id, items, items_cambio, tipo_reembolso, moneda_reembolso,
    metodo_pago_id, motivo, cliente_id, monto_manual
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

    // --- Productos que vuelven al inventario ---
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

    const hayCambio = items_cambio && items_cambio.length > 0;
    const monedaFinal = moneda_reembolso || monedaOriginalVenta;

    let tasa = null;
    if ((tipo_reembolso && tipo_reembolso !== 'ninguno') || hayCambio || monedaFinal !== monedaOriginalVenta) {
      const tasaResultado = await client.query(
        'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
      );
      if (tasaResultado.rows.length === 0) throw new Error('No hay tasa de cambio registrada');
      tasa = tasaResultado.rows[0];
    }

    // --- Productos que se entregan a cambio: salen del inventario, valorizados a precio actual ---
    let montoCambioLiquidacion = 0;
    const detallesCambio = [];
    if (hayCambio) {
      for (const itemCambio of items_cambio) {
        const cantidad = Number(itemCambio.cantidad) || 0;
        if (cantidad <= 0) continue;

        const productoResultado = await client.query(
          'SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE',
          [itemCambio.producto_id]
        );
        if (productoResultado.rows.length === 0) throw new Error(`Producto de cambio ${itemCambio.producto_id} no encontrado`);
        const productoCambio = productoResultado.rows[0];

        if (productoCambio.stock < cantidad) {
          throw new Error(`Stock insuficiente para "${productoCambio.nombre}" (disponible: ${productoCambio.stock})`);
        }

        const precioUnitarioCambio = precioEfectivoEnMoneda(productoCambio, monedaFinal, tasa);
        const subtotalCambio = redondear(precioUnitarioCambio * cantidad, 2);
        montoCambioLiquidacion = redondear(montoCambioLiquidacion + subtotalCambio, 2);

        detallesCambio.push({
          producto_id: productoCambio.id,
          cantidad,
          precio_unitario_original: precioUnitarioCambio,
          subtotal_original: subtotalCambio,
          moneda_original: monedaFinal,
        });

        await client.query(
          'UPDATE productos SET stock = stock - $1, updated_at = NOW() WHERE id = $2',
          [cantidad, productoCambio.id]
        );
      }
    }

    // --- Diferencia a liquidar: positiva = se le debe al cliente; negativa = el cliente paga ---
    const valorDevueltoLiquidacion = redondear(
      monedaFinal === monedaOriginalVenta ? montoTotalOriginal : convertirEntreMonedas(montoTotalOriginal, monedaOriginalVenta, monedaFinal, tasa),
      2
    );
    let diferencia = redondear(valorDevueltoLiquidacion - montoCambioLiquidacion, 2);

    if (monto_manual != null && monto_manual !== '') {
      const magnitud = Math.abs(Number(monto_manual));
      diferencia = diferencia >= 0 ? magnitud : -magnitud;
    }

    const tipoFinal = tipo_reembolso || 'ninguno';
    const huboDiferencia = Math.abs(diferencia) > 0.01;

    let clienteDestino = null;
    if (tipoFinal === 'fiado' && diferencia >= 0 && !venta.cliente_id) {
      throw new Error('Esta venta no tiene cliente asociado para reducir el fiado');
    }
    if (tipoFinal === 'fiado' && diferencia < 0) {
      clienteDestino = venta.cliente_id || cliente_id || null;
      if (!clienteDestino) throw new Error('Elegí a qué cliente se le fía la diferencia');
    }
    if (tipoFinal === 'credito') {
      if (diferencia < 0) throw new Error('No se puede dar saldo a favor cuando el cliente debe pagar diferencia');
      clienteDestino = venta.cliente_id || cliente_id || null;
      if (!clienteDestino) throw new Error('Elegí a qué cliente guardarle el saldo a favor');
    }
    if (tipoFinal === 'efectivo') {
      if (!metodo_pago_id) throw new Error('Indicá con qué método se movió el dinero');
      if (huboDiferencia && !sesionCajaId) throw new Error('No hay una caja abierta para registrar este movimiento');
    }

    const devolucionResultado = await client.query(
      `INSERT INTO devoluciones (venta_id, tipo_reembolso, monto_reembolsado, moneda_reembolso, motivo, sesion_caja_id, usuario_id, cliente_credito_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        venta_id, tipoFinal, huboDiferencia ? Math.abs(diferencia) : 0, huboDiferencia ? monedaFinal : null,
        motivo || null, sesionCajaId, usuario_id,
        clienteDestino && !venta.cliente_id ? clienteDestino : null
      ]
    );
    const devolucion = devolucionResultado.rows[0];

    for (const d of detallesDevolucion) {
      await client.query(
        `INSERT INTO detalle_devolucion (devolucion_id, producto_id, cantidad, precio_unitario_original, subtotal_original, moneda_original, tipo_item)
         VALUES ($1, $2, $3, $4, $5, $6, 'devuelto')`,
        [devolucion.id, d.producto_id, d.cantidad, d.precio_unitario_original, d.subtotal_original, d.moneda_original]
      );
    }
    for (const d of detallesCambio) {
      await client.query(
        `INSERT INTO detalle_devolucion (devolucion_id, producto_id, cantidad, precio_unitario_original, subtotal_original, moneda_original, tipo_item)
         VALUES ($1, $2, $3, $4, $5, $6, 'entregado')`,
        [devolucion.id, d.producto_id, d.cantidad, d.precio_unitario_original, d.subtotal_original, d.moneda_original]
      );
    }

    if (huboDiferencia && tipoFinal === 'efectivo') {
      const direccion = diferencia > 0 ? 'egreso' : 'ingreso';
      const concepto = diferencia > 0
        ? `Devolución venta ${venta.numero_venta}`
        : `Cobro por cambio · venta ${venta.numero_venta}`;
      const montoUsd = convertirAUSD(Math.abs(diferencia), monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sesionCajaId, direccion, concepto, monedaFinal, Math.abs(diferencia), montoUsd, usuario_id]
      );
    }

    if (huboDiferencia && tipoFinal === 'fiado') {
      const montoUsd = convertirAUSD(Math.abs(diferencia), monedaFinal, tasa);
      if (diferencia > 0) {
        await client.query(
          `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
           VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)`,
          [venta.cliente_id, monedaFinal, diferencia, montoUsd, venta_id, sesionCajaId, usuario_id, `Devolución venta ${venta.numero_venta}`]
        );
      } else {
        await client.query(
          `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
           VALUES ($1, 'cargo', $2, $3, $4, $5, $6, $7, $8)`,
          [clienteDestino, monedaFinal, Math.abs(diferencia), montoUsd, venta_id, sesionCajaId, usuario_id, `Diferencia por cambio · venta ${venta.numero_venta}`]
        );
      }
    }

    if (huboDiferencia && tipoFinal === 'credito') {
      const montoUsd = convertirAUSD(diferencia, monedaFinal, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)`,
        [clienteDestino, monedaFinal, diferencia, montoUsd, venta_id, sesionCajaId, usuario_id, `Saldo a favor por devolución ${venta.numero_venta}`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      devolucion,
      detalles: detallesDevolucion,
      detalles_cambio: detallesCambio,
      diferencia,
      moneda_liquidacion: huboDiferencia ? monedaFinal : null,
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
            'subtotal_original', dd.subtotal_original, 'moneda_original', dd.moneda_original,
            'tipo_item', dd.tipo_item
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