const pool = require('../../config/db');

function filtroFechas(desde, hasta) {
  const condiciones = [];
  const params = [];
  if (desde) {
    params.push(desde);
    condiciones.push(`v.fecha >= $${params.length}::date`);
  }
  if (hasta) {
    params.push(hasta);
    condiciones.push(`v.fecha < ($${params.length}::date + INTERVAL '1 day')`);
  }
  return { condiciones, params };
}

async function resumenGeneral(req, res) {
  const { desde, hasta } = req.query;
  const { condiciones, params } = filtroFechas(desde, hasta);
  const extra = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';

  try {
    const totales = await pool.query(
      `SELECT COUNT(*) AS cantidad_ventas, COALESCE(SUM(total_usd), 0) AS total_usd
       FROM ventas v WHERE v.estado = 'completada' ${extra}`,
      params
    );

    const stockBajo = await pool.query(
      `SELECT COUNT(*) AS cantidad FROM productos WHERE activo = true AND stock <= 3`
    );

    res.json({
      cantidad_ventas: Number(totales.rows[0].cantidad_ventas),
      total_usd: Number(totales.rows[0].total_usd),
      productos_stock_bajo: Number(stockBajo.rows[0].cantidad)
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al generar resumen', error: error.message });
  }
}

async function productosMasVendidos(req, res) {
  const { desde, hasta, limite } = req.query;
  const { condiciones, params } = filtroFechas(desde, hasta);
  const extra = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';
  params.push(Number(limite) || 10);

  try {
    const resultado = await pool.query(
      `SELECT p.id, p.nombre, p.codigo, SUM(dv.cantidad) AS unidades_vendidas, SUM(dv.subtotal_usd) AS total_usd
       FROM detalle_venta dv
       JOIN ventas v ON v.id = dv.venta_id
       JOIN productos p ON p.id = dv.producto_id
       WHERE v.estado = 'completada' ${extra}
       GROUP BY p.id, p.nombre, p.codigo
       ORDER BY unidades_vendidas DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos más vendidos', error: error.message });
  }
}

async function ventasPorMetodoPago(req, res) {
  const { desde, hasta } = req.query;
  const { condiciones, params } = filtroFechas(desde, hasta);
  const extra = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';

  try {
    const resultado = await pool.query(
      `SELECT mp.nombre AS metodo, pv.moneda, SUM(pv.monto) AS total, SUM(pv.monto_equivalente_usd) AS total_usd
       FROM pagos_venta pv
       JOIN ventas v ON v.id = pv.venta_id
       JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
       WHERE v.estado = 'completada' ${extra}
       GROUP BY mp.nombre, pv.moneda
       ORDER BY mp.nombre, pv.moneda`,
      params
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas por método de pago', error: error.message });
  }
}

async function ventasPorMoneda(req, res) {
  const { desde, hasta } = req.query;
  const { condiciones, params } = filtroFechas(desde, hasta);
  const extra = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';

  try {
    const resultado = await pool.query(
      `SELECT pv.moneda, SUM(pv.monto) AS total, SUM(pv.monto_equivalente_usd) AS total_usd
       FROM pagos_venta pv
       JOIN ventas v ON v.id = pv.venta_id
       WHERE v.estado = 'completada' ${extra}
       GROUP BY pv.moneda`,
      params
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas por moneda', error: error.message });
  }
}

async function ventasDiarias(req, res) {
  const { desde, hasta } = req.query;
  const { condiciones, params } = filtroFechas(desde, hasta);
  const extra = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';

  try {
    const resultado = await pool.query(
      `SELECT DATE(v.fecha) AS dia, COUNT(*) AS cantidad_ventas, SUM(v.total_usd) AS total_usd
       FROM ventas v
       WHERE v.estado = 'completada' ${extra}
       GROUP BY DATE(v.fecha)
       ORDER BY dia DESC`,
      params
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas diarias', error: error.message });
  }
}

async function menorRotacion(req, res) {
  const { limite } = req.query;
  try {
    const resultado = await pool.query(
      `SELECT p.id, p.nombre, p.codigo, p.stock, COALESCE(SUM(dv.cantidad), 0) AS unidades_vendidas
       FROM productos p
       LEFT JOIN detalle_venta dv ON dv.producto_id = p.id
       LEFT JOIN ventas v ON v.id = dv.venta_id AND v.estado = 'completada'
       WHERE p.activo = true
       GROUP BY p.id, p.nombre, p.codigo, p.stock
       ORDER BY unidades_vendidas ASC, p.stock DESC
       LIMIT $1`,
      [Number(limite) || 10]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos de menor rotación', error: error.message });
  }
}

module.exports = {
  resumenGeneral,
  productosMasVendidos,
  ventasPorMetodoPago,
  ventasPorMoneda,
  ventasDiarias,
  menorRotacion
};