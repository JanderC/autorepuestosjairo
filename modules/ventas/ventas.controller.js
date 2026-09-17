const pool = require('../../config/db');
const { convertirAUSD, convertirEntreMonedas, precioEfectivoEnMoneda, redondear } = require('../../utils/conversionMoneda');

function generarNumeroVenta() {
  const timestamp = Date.now().toString().slice(-10);
  return `VTA-${timestamp}`;
}

async function obtenerTasaVigente(client) {
  const resultado = await client.query(
    'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
  );
  if (resultado.rows.length === 0) {
    throw new Error('No hay una tasa de cambio registrada. Registra una tasa antes de vender.');
  }
  return resultado.rows[0];
}

async function resolverSesionCajaAbierta(client) {
  const resultado = await client.query(
    `SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`
  );
  return resultado.rows[0]?.id || null;
}

async function obtenerSaldoCliente(client, clienteId, moneda) {
  const resultado = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN tipo='cargo' THEN monto ELSE 0 END),0) -
            COALESCE(SUM(CASE WHEN tipo='abono' THEN monto ELSE 0 END),0) AS saldo
     FROM movimientos_cuenta WHERE cliente_id = $1 AND moneda = $2`,
    [clienteId, moneda]
  );
  return Number(resultado.rows[0].saldo);
}

async function crearVenta(req, res) {
  const { productos, pagos, cliente_id, moneda_venta, aplicar_credito } = req.body;
  const usuario_id = req.usuario.id;

  if (!productos || productos.length === 0) {
    return res.status(400).json({ message: 'Debe incluir al menos un producto' });
  }
  if (!pagos) {
    return res.status(400).json({ message: 'Debe incluir información de pago' });
  }
  if (pagos.length === 0 && !cliente_id && !(aplicar_credito > 0)) {
    return res.status(400).json({ message: 'Debe incluir al menos un método de pago, o asignar un cliente para fiar completo' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tasa = await obtenerTasaVigente(client);
    const monedaEfectiva = moneda_venta || 'USD';
    const sesionCajaResuelta = await resolverSesionCajaAbierta(client);

    const detalles = [];
    let totalEnMonedaVenta = 0;
    let totalUSD = 0;
    let totalListaUSD = 0;

    for (const item of productos) {
      const resultadoProducto = await client.query(
        'SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE',
        [item.producto_id]
      );
      if (resultadoProducto.rows.length === 0) {
        throw new Error(`Producto con id ${item.producto_id} no encontrado`);
      }
      const producto = resultadoProducto.rows[0];

      if (producto.stock < item.cantidad) {
        throw new Error(`Stock insuficiente para "${producto.nombre}" (disponible: ${producto.stock})`);
      }

      const precioListaOriginal = precioEfectivoEnMoneda(producto, monedaEfectiva, tasa);

      const tienePrecioManual = item.precio_unitario_manual != null && item.precio_unitario_manual !== '';
      const precioUnitarioOriginal = tienePrecioManual
        ? redondear(Number(item.precio_unitario_manual), 2)
        : precioListaOriginal;

      const subtotalOriginal = redondear(precioUnitarioOriginal * item.cantidad, 2);
      totalEnMonedaVenta = redondear(totalEnMonedaVenta + subtotalOriginal, 2);

      const precioListaUSD = convertirAUSD(precioListaOriginal, monedaEfectiva, tasa);
      totalListaUSD += precioListaUSD * item.cantidad;

      const precioUnitarioUSD = convertirAUSD(precioUnitarioOriginal, monedaEfectiva, tasa);
      const subtotalUSD = precioUnitarioUSD * item.cantidad;
      totalUSD += subtotalUSD;

      detalles.push({
        producto_id: producto.id,
        cantidad: item.cantidad,
        precio_unitario_usd: precioUnitarioUSD,
        subtotal_usd: subtotalUSD,
        precio_unitario_original: precioUnitarioOriginal,
        subtotal_original: subtotalOriginal,
        moneda_original: monedaEfectiva
      });

      await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [item.cantidad, producto.id]);
    }

    const ajusteUSD = redondear(totalListaUSD - totalUSD, 2);
    const huboAjuste = Math.abs(ajusteUSD) > 0.005;
    const ajusteUsuarioId = huboAjuste ? usuario_id : null;

    let restanteEnMonedaVenta = totalEnMonedaVenta;

    // Saldo a favor: se descuenta ANTES que cualquier pago en efectivo.
    let creditoAplicadoFinal = 0;
    if (aplicar_credito && Number(aplicar_credito) > 0) {
      if (!cliente_id) throw new Error('Para aplicar saldo a favor necesitás asociar un cliente a la venta');

      const saldo = await obtenerSaldoCliente(client, cliente_id, monedaEfectiva);
      const creditoDisponible = saldo < 0 ? Math.abs(saldo) : 0;
      if (creditoDisponible <= 0) {
        throw new Error(`El cliente no tiene saldo a favor en ${monedaEfectiva}`);
      }

      creditoAplicadoFinal = Math.min(Number(aplicar_credito), creditoDisponible, restanteEnMonedaVenta);
      restanteEnMonedaVenta = redondear(restanteEnMonedaVenta - creditoAplicadoFinal, 2);
    }

    let excedenteEnMonedaVenta = 0;
    const pagosCalculados = [];

    for (const pago of pagos) {
      const metodoResultado = await client.query(
        'SELECT id, nombre FROM metodos_pago WHERE id = $1 AND activo = true',
        [pago.metodo_pago_id]
      );
      if (metodoResultado.rows.length === 0) {
        throw new Error('Método de pago inválido');
      }

      const montoEnMonedaVenta = redondear(convertirEntreMonedas(pago.monto, pago.moneda, monedaEfectiva, tasa), 2);

      if (restanteEnMonedaVenta <= 0.005) {
        excedenteEnMonedaVenta = redondear(excedenteEnMonedaVenta + montoEnMonedaVenta, 2);
        continue;
      }

      if (montoEnMonedaVenta <= restanteEnMonedaVenta + 0.005) {
        pagosCalculados.push({
          moneda: pago.moneda,
          metodo_pago_id: pago.metodo_pago_id,
          referencia: pago.referencia || null,
          monto: Number(pago.monto),
          monto_equivalente_usd: convertirAUSD(pago.monto, pago.moneda, tasa)
        });
        restanteEnMonedaVenta = redondear(restanteEnMonedaVenta - montoEnMonedaVenta, 2);
      } else {
        const aplicadoEnMonedaVenta = restanteEnMonedaVenta;
        const aplicadoEnMonedaPago = pago.moneda === monedaEfectiva
          ? aplicadoEnMonedaVenta
          : redondear(convertirEntreMonedas(aplicadoEnMonedaVenta, monedaEfectiva, pago.moneda, tasa), 2);

        pagosCalculados.push({
          moneda: pago.moneda,
          metodo_pago_id: pago.metodo_pago_id,
          referencia: pago.referencia || null,
          monto: aplicadoEnMonedaPago,
          monto_equivalente_usd: convertirAUSD(aplicadoEnMonedaPago, pago.moneda, tasa)
        });
        excedenteEnMonedaVenta = redondear(excedenteEnMonedaVenta + (montoEnMonedaVenta - aplicadoEnMonedaVenta), 2);
        restanteEnMonedaVenta = 0;
      }
    }

    if (restanteEnMonedaVenta > 0.01 && !cliente_id) {
      throw new Error(
        `El monto pagado es menor al total de la venta (faltan ${restanteEnMonedaVenta.toFixed(2)} ${monedaEfectiva}). Asigna un cliente para fiar el resto.`
      );
    }

    const esFiado = restanteEnMonedaVenta > 0.01;
    const estadoVenta = esFiado ? 'fiado' : 'completada';

    let vueltoMonedaFinal = null;
    let vueltoMontoFinal = null;
    if (excedenteEnMonedaVenta > 0.01) {
      vueltoMonedaFinal = monedaEfectiva;
      vueltoMontoFinal = excedenteEnMonedaVenta;
    }

    const numeroVenta = generarNumeroVenta();
    const ventaResultado = await client.query(
      `INSERT INTO ventas (
        numero_venta, usuario_id, total_usd, total_lista_usd, ajuste_usd, ajuste_usuario_id,
        tasa_id, estado, cliente_id, sesion_caja_id, vuelto_moneda, vuelto_monto
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        numeroVenta, usuario_id, totalUSD, redondear(totalListaUSD, 2), ajusteUSD, ajusteUsuarioId,
        tasa.id, estadoVenta, cliente_id || null, sesionCajaResuelta, vueltoMonedaFinal, vueltoMontoFinal
      ]
    );
    const venta = ventaResultado.rows[0];

    for (const detalle of detalles) {
      await client.query(
        `INSERT INTO detalle_venta (venta_id, producto_id, cantidad, precio_unitario_usd, subtotal_usd, precio_unitario_original, subtotal_original, moneda_original)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [venta.id, detalle.producto_id, detalle.cantidad, detalle.precio_unitario_usd, detalle.subtotal_usd,
         detalle.precio_unitario_original, detalle.subtotal_original, detalle.moneda_original]
      );
    }

    for (const pago of pagosCalculados) {
      await client.query(
        `INSERT INTO pagos_venta (venta_id, moneda, metodo_pago_id, monto, monto_equivalente_usd, referencia)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [venta.id, pago.moneda, pago.metodo_pago_id, pago.monto, pago.monto_equivalente_usd, pago.referencia]
      );
    }

    if (creditoAplicadoFinal > 0) {
      const usdInformativo = convertirAUSD(creditoAplicadoFinal, monedaEfectiva, tasa);
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id, referencia)
         VALUES ($1, 'cargo', $2, $3, $4, $5, $6, $7, $8)`,
        [cliente_id, monedaEfectiva, creditoAplicadoFinal, usdInformativo, venta.id, sesionCajaResuelta, usuario_id, 'Aplicó saldo a favor']
      );
    }

    if (esFiado) {
      const montoCargo = restanteEnMonedaVenta;
      const usdInformativo = convertirAUSD(montoCargo, monedaEfectiva, tasa);

      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, saldo_pendiente_original, venta_id, sesion_caja_id, usuario_id)
         VALUES ($1, 'cargo', $2, $3, $4, $3, $5, $6, $7)`,
        [cliente_id, monedaEfectiva, montoCargo, usdInformativo, venta.id, sesionCajaResuelta, usuario_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      venta,
      detalles,
      pagos: pagosCalculados,
      credito_aplicado: creditoAplicadoFinal,
      vuelto_usd: convertirAUSD(excedenteEnMonedaVenta, monedaEfectiva, tasa),
      vuelto_moneda: vueltoMonedaFinal,
      vuelto_monto: vueltoMontoFinal,
      es_fiado: esFiado,
      saldo_fiado: esFiado ? restanteEnMonedaVenta : 0,
      saldo_fiado_moneda: monedaEfectiva,
      tiene_ajuste: huboAjuste,
      ajuste_usd: ajusteUSD
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function listarVentas(req, res) {
  const { desde, hasta } = req.query;
  try {
    let query = `
      SELECT v.*, u.nombre AS vendedor, c.nombre AS cliente_nombre,
        COALESCE(SUM(CASE WHEN pv.moneda = 'USD' THEN pv.monto END), 0) AS monto_usd,
        COALESCE(SUM(CASE WHEN pv.moneda = 'COP' THEN pv.monto END), 0) AS monto_cop,
        COALESCE(SUM(CASE WHEN pv.moneda = 'BS' THEN pv.monto END), 0) AS monto_bs
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN pagos_venta pv ON pv.venta_id = v.id
    `;
    const params = [];
    if (desde && hasta) {
      query += ` WHERE v.fecha >= $1::date AND v.fecha < ($2::date + INTERVAL '1 day')`;
      params.push(desde, hasta);
    }
    query += ` GROUP BY v.id, u.nombre, c.nombre ORDER BY v.fecha DESC`;
    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar ventas', error: error.message });
  }
}

async function obtenerVentaPorId(req, res) {
  const { id } = req.params;
  try {
    const ventaResultado = await pool.query('SELECT * FROM ventas WHERE id = $1', [id]);
    if (ventaResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Venta no encontrada' });
    }
    const venta = ventaResultado.rows[0];

    const detalles = await pool.query(
      `SELECT dv.*, p.nombre, p.codigo FROM detalle_venta dv JOIN productos p ON p.id = dv.producto_id WHERE dv.venta_id = $1`,
      [id]
    );
    const pagos = await pool.query(
      `SELECT pv.*, mp.nombre AS metodo_nombre FROM pagos_venta pv JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id WHERE pv.venta_id = $1`,
      [id]
    );

    let cliente = null;
    let fiado = null;
    if (venta.cliente_id) {
      const clienteResultado = await pool.query('SELECT id, nombre, telefono FROM clientes WHERE id = $1', [venta.cliente_id]);
      cliente = clienteResultado.rows[0] || null;
      const cargoResultado = await pool.query(`SELECT * FROM movimientos_cuenta WHERE venta_id = $1 AND tipo = 'cargo'`, [id]);
      fiado = cargoResultado.rows[0] || null;
    }

    res.json({ venta, detalles: detalles.rows, pagos: pagos.rows, cliente, fiado });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta', error: error.message });
  }
}

module.exports = { crearVenta, listarVentas, obtenerVentaPorId };