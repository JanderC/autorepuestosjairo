const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

const MONEDAS = ['USD', 'COP', 'BS'];

// Match robusto de "efectivo": no depende de que el nombre esté escrito exactamente igual
const CONDICION_EFECTIVO = `TRIM(LOWER(mp.nombre)) = 'efectivo'`;

async function obtenerSesionAbierta(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT sc.*, u.nombre AS usuario_nombre
       FROM sesiones_caja sc
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.estado = 'abierta'
       ORDER BY sc.fecha_apertura DESC
       LIMIT 1`
    );
    res.json(resultado.rows[0] || null);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la sesión de caja', error: error.message });
  }
}

async function abrirCaja(req, res) {
  const { fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_bs } = req.body;
  const usuario_id = req.usuario.id;

  try {
    const existente = await pool.query(`SELECT id FROM sesiones_caja WHERE estado = 'abierta'`);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya hay una sesión de caja abierta' });
    }

    const resultado = await pool.query(
      `INSERT INTO sesiones_caja (usuario_id, fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_bs)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [usuario_id, fondo_inicial_usd || 0, fondo_inicial_cop || 0, fondo_inicial_bs || 0]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al abrir caja', error: error.message });
  }
}

async function registrarMovimiento(req, res) {
  const { tipo, concepto, moneda, monto } = req.body;
  const usuario_id = req.usuario.id;

  if (!['ingreso', 'egreso'].includes(tipo)) {
    return res.status(400).json({ message: 'Tipo de movimiento inválido' });
  }

  try {
    // La sesión se resuelve acá, no se confía en la que mande el frontend
    const sesionResultado = await pool.query(
      `SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`
    );
    if (sesionResultado.rows.length === 0) {
      return res.status(400).json({ message: 'No hay una caja abierta para registrar el movimiento' });
    }
    const sesionCajaId = sesionResultado.rows[0].id;

    const tasaResultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    if (tasaResultado.rows.length === 0) {
      return res.status(400).json({ message: 'No hay tasa de cambio registrada' });
    }
    const tasa = tasaResultado.rows[0];
    const montoUsd = convertirAUSD(monto, moneda, tasa);

    const resultado = await pool.query(
      `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [sesionCajaId, tipo, concepto, moneda, monto, montoUsd, usuario_id]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar movimiento', error: error.message });
  }
}

// Calcula, para una sesión y moneda, cada componente del cuadre por separado
async function calcularDesglose(sesion, moneda) {
  const id = sesion.id;

  const ventasEfectivo = await pool.query(
    `SELECT COALESCE(SUM(pv.monto), 0) AS total
     FROM pagos_venta pv
     JOIN ventas v ON v.id = pv.venta_id
     JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
     WHERE v.sesion_caja_id = $1 AND ${CONDICION_EFECTIVO} AND pv.moneda = $2 AND v.estado <> 'anulada'`,
    [id, moneda]
  );

  const ventasOtros = await pool.query(
    `SELECT COALESCE(SUM(pv.monto), 0) AS total
     FROM pagos_venta pv
     JOIN ventas v ON v.id = pv.venta_id
     JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
     WHERE v.sesion_caja_id = $1 AND NOT ${CONDICION_EFECTIVO} AND pv.moneda = $2 AND v.estado <> 'anulada'`,
    [id, moneda]
  );

  const ingresos = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja
     WHERE sesion_caja_id = $1 AND tipo = 'ingreso' AND moneda = $2`,
    [id, moneda]
  );

  const egresos = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja
     WHERE sesion_caja_id = $1 AND tipo = 'egreso' AND moneda = $2`,
    [id, moneda]
  );

  const abonosEfectivo = await pool.query(
    `SELECT COALESCE(SUM(mc.monto), 0) AS total
     FROM movimientos_cuenta mc
     JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
     WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono' AND ${CONDICION_EFECTIVO} AND mc.moneda = $2`,
    [id, moneda]
  );

  const fiadoOtorgado = await pool.query(
    `SELECT COALESCE(SUM(monto), 0) AS total
     FROM movimientos_cuenta
     WHERE sesion_caja_id = $1 AND tipo = 'cargo' AND moneda = $2`,
    [id, moneda]
  );

  const fondo_inicial = Number(sesion[`fondo_inicial_${moneda.toLowerCase()}`]) || 0;
  const ventas_efectivo = Number(ventasEfectivo.rows[0].total);
  const ventas_otros_metodos = Number(ventasOtros.rows[0].total);
  const total_ingresos = Number(ingresos.rows[0].total);
  const total_egresos = Number(egresos.rows[0].total);
  const abonos_efectivo = Number(abonosEfectivo.rows[0].total);
  const fiado_otorgado = Number(fiadoOtorgado.rows[0].total);

  return {
    moneda,
    fondo_inicial,
    ventas_efectivo,
    ventas_otros_metodos,
    ventas_totales: ventas_efectivo + ventas_otros_metodos,
    ingresos: total_ingresos,
    egresos: total_egresos,
    abonos_efectivo,
    fiado_otorgado,
    // Solo el efectivo físico entra al cuadre: lo que se pagó por transferencia/punto no está en el cajón
    esperado_efectivo: fondo_inicial + ventas_efectivo + total_ingresos - total_egresos + abonos_efectivo
  };
}

async function resumenSesion(req, res) {
  const { id } = req.params;

  try {
    const sesionResultado = await pool.query(
      `SELECT sc.*, u.nombre AS usuario_nombre
       FROM sesiones_caja sc JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.id = $1`,
      [id]
    );
    if (sesionResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Sesión no encontrada' });
    }
    const sesion = sesionResultado.rows[0];

    const desglose = [];
    for (const moneda of MONEDAS) {
      desglose.push(await calcularDesglose(sesion, moneda));
    }

    const pagosPorMetodo = await pool.query(
      `SELECT mp.nombre AS metodo, pv.moneda, SUM(pv.monto) AS total
       FROM pagos_venta pv
       JOIN ventas v ON v.id = pv.venta_id
       JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
       WHERE v.sesion_caja_id = $1 AND v.estado <> 'anulada'
       GROUP BY mp.nombre, pv.moneda
       ORDER BY pv.moneda, mp.nombre`,
      [id]
    );

    const cantidadVentas = await pool.query(
      `SELECT COUNT(*) AS cantidad FROM ventas WHERE sesion_caja_id = $1 AND estado <> 'anulada'`,
      [id]
    );

    res.json({
      sesion,
      desglose,
      pagos_por_metodo: pagosPorMetodo.rows,
      cantidad_ventas: Number(cantidadVentas.rows[0].cantidad)
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen', error: error.message });
  }
}

async function cerrarCaja(req, res) {
  const { id } = req.params;
  const { conteo_final_usd, conteo_final_cop, conteo_final_bs, notas_cierre } = req.body;

  try {
    const sesionResultado = await pool.query('SELECT * FROM sesiones_caja WHERE id = $1', [id]);
    if (sesionResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Sesión no encontrada' });
    }
    const sesion = sesionResultado.rows[0];
    if (sesion.estado === 'cerrada') {
      return res.status(400).json({ message: 'Esta sesión ya está cerrada' });
    }

    const desgloseUsd = await calcularDesglose(sesion, 'USD');
    const desgloseCop = await calcularDesglose(sesion, 'COP');
    const desgloseBs = await calcularDesglose(sesion, 'BS');

    const conteos = {
      usd: Number(conteo_final_usd) || 0,
      cop: Number(conteo_final_cop) || 0,
      bs: Number(conteo_final_bs) || 0
    };

    const resultado = await pool.query(
      `UPDATE sesiones_caja SET
        conteo_final_usd = $1, conteo_final_cop = $2, conteo_final_bs = $3,
        esperado_final_usd = $4, esperado_final_cop = $5, esperado_final_bs = $6,
        diferencia_usd = $7, diferencia_cop = $8, diferencia_bs = $9,
        estado = 'cerrada', fecha_cierre = NOW(), notas_cierre = $10
       WHERE id = $11
       RETURNING *`,
      [
        conteos.usd, conteos.cop, conteos.bs,
        desgloseUsd.esperado_efectivo, desgloseCop.esperado_efectivo, desgloseBs.esperado_efectivo,
        conteos.usd - desgloseUsd.esperado_efectivo,
        conteos.cop - desgloseCop.esperado_efectivo,
        conteos.bs - desgloseBs.esperado_efectivo,
        notas_cierre || null, id
      ]
    );

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al cerrar caja', error: error.message });
  }
}

async function listarHistorialSesiones(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT sc.*, u.nombre AS usuario_nombre,
              (SELECT COUNT(*) FROM ventas v WHERE v.sesion_caja_id = sc.id AND v.estado <> 'anulada') AS cantidad_ventas
       FROM sesiones_caja sc
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.estado = 'cerrada'
       ORDER BY sc.fecha_cierre DESC
       LIMIT 60`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar historial', error: error.message });
  }
}

async function movimientosDelDia(req, res) {
  const { id } = req.params;
  try {
    const ventas = await pool.query(
      `SELECT v.id, v.numero_venta, v.fecha, v.estado, u.nombre AS usuario,
              COALESCE(SUM(CASE WHEN pv.moneda='USD' THEN pv.monto END),0) AS usd,
              COALESCE(SUM(CASE WHEN pv.moneda='COP' THEN pv.monto END),0) AS cop,
              COALESCE(SUM(CASE WHEN pv.moneda='BS' THEN pv.monto END),0) AS bs
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN pagos_venta pv ON pv.venta_id = v.id
       WHERE v.sesion_caja_id = $1 AND v.estado <> 'anulada'
       GROUP BY v.id, u.nombre`,
      [id]
    );

    const movimientos = await pool.query(
      `SELECT mc.id, mc.tipo, mc.concepto, mc.moneda, mc.monto, mc.fecha, u.nombre AS usuario
       FROM movimientos_caja mc JOIN usuarios u ON u.id = mc.usuario_id
       WHERE mc.sesion_caja_id = $1`,
      [id]
    );

    const abonos = await pool.query(
      `SELECT mc.id, mc.moneda, mc.monto, mc.fecha, c.nombre AS cliente, mp.nombre AS metodo
       FROM movimientos_cuenta mc
       JOIN clientes c ON c.id = mc.cliente_id
       LEFT JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono'`,
      [id]
    );

    const fiados = await pool.query(
      `SELECT mc.id, mc.moneda, mc.monto, mc.fecha, c.nombre AS cliente
       FROM movimientos_cuenta mc
       JOIN clientes c ON c.id = mc.cliente_id
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'cargo'`,
      [id]
    );

    const eventos = [
      ...ventas.rows.map((v) => ({
        tipo: 'venta', id: v.id, estado: v.estado, fecha: v.fecha,
        detalle: `Venta ${v.numero_venta} · ${v.usuario}`,
        usd: Number(v.usd), cop: Number(v.cop), bs: Number(v.bs)
      })),
      ...movimientos.rows.map((m) => ({
        tipo: m.tipo, fecha: m.fecha, detalle: `${m.concepto} · ${m.usuario}`,
        moneda: m.moneda, monto: Number(m.monto)
      })),
      ...abonos.rows.map((a) => ({
        tipo: 'abono', fecha: a.fecha, detalle: `Abono de ${a.cliente}${a.metodo ? ` (${a.metodo})` : ''}`,
        moneda: a.moneda, monto: Number(a.monto)
      })),
      ...fiados.rows.map((f) => ({
        tipo: 'fiado', fecha: f.fecha, detalle: `Fiado a ${f.cliente}`,
        moneda: f.moneda, monto: Number(f.monto)
      }))
    ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json(eventos);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener movimientos', error: error.message });
  }
}

module.exports = {
  obtenerSesionAbierta,
  abrirCaja,
  registrarMovimiento,
  resumenSesion,
  cerrarCaja,
  listarHistorialSesiones,
  movimientosDelDia
};