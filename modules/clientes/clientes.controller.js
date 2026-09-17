const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

async function listarClientes(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM clientes WHERE activo = true ORDER BY nombre ASC'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar clientes', error: error.message });
  }
}

async function buscarClientes(req, res) {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ message: 'El parámetro q es requerido' });
  }
  try {
    const resultado = await pool.query(
      `SELECT * FROM clientes WHERE activo = true AND (nombre ILIKE $1 OR telefono ILIKE $1) ORDER BY nombre ASC LIMIT 20`,
      [`%${q}%`]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar clientes', error: error.message });
  }
}

async function crearCliente(req, res) {
  const { nombre, telefono, identificacion, nota } = req.body;

  if (!nombre) {
    return res.status(400).json({ message: 'El nombre es requerido' });
  }

  try {
    const resultado = await pool.query(
      `INSERT INTO clientes (nombre, telefono, identificacion, nota)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [nombre, telefono || null, identificacion || null, nota || null]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cliente', error: error.message });
  }
}

// Saldo por moneda: positivo = debe (fiado), negativo = tiene saldo a favor.
// Ya NO se filtran los negativos — antes un HAVING > 0.01 los escondía por completo.
async function obtenerEstadoCuenta(req, res) {
  const { id } = req.params;
  try {
    const clienteResultado = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (clienteResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }

    const saldos = await pool.query(
      `SELECT moneda,
        COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN tipo = 'abono' THEN monto ELSE 0 END), 0) AS saldo_pendiente
       FROM movimientos_cuenta
       WHERE cliente_id = $1
       GROUP BY moneda
       HAVING ABS(
         COALESCE(SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN tipo = 'abono' THEN monto ELSE 0 END), 0)
       ) > 0.01`,
      [id]
    );

    const movimientos = await pool.query(
      `SELECT mc.*, v.numero_venta, mp.nombre AS metodo_nombre
       FROM movimientos_cuenta mc
       LEFT JOIN ventas v ON v.id = mc.venta_id
       LEFT JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
       WHERE mc.cliente_id = $1
       ORDER BY mc.fecha DESC`,
      [id]
    );

    res.json({
      cliente: clienteResultado.rows[0],
      saldos_pendientes: saldos.rows,
      movimientos: movimientos.rows
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estado de cuenta', error: error.message });
  }
}

async function registrarAbono(req, res) {
  const { cliente_id, moneda, monto, metodo_pago_id, referencia } = req.body;
  const usuario_id = req.usuario.id;

  if (!cliente_id || !moneda || monto == null) {
    return res.status(400).json({ message: 'cliente_id, moneda y monto son requeridos' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tasaResultado = await client.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    if (tasaResultado.rows.length === 0) {
      throw new Error('No hay tasa de cambio registrada');
    }
    const tasa = tasaResultado.rows[0];
    const montoUsd = convertirAUSD(monto, moneda, tasa);

    const sesionResultado = await client.query(
      `SELECT id FROM sesiones_caja WHERE estado = 'abierta' ORDER BY fecha_apertura DESC LIMIT 1`
    );
    const sesionCajaResuelta = sesionResultado.rows[0]?.id || null;

    const resultado = await client.query(
      `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, metodo_pago_id, referencia, sesion_caja_id, usuario_id)
       VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [cliente_id, moneda, monto, montoUsd, metodo_pago_id || null, referencia || null, sesionCajaResuelta, usuario_id]
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

async function listarFiadosPendientes(req, res) {
  try {
    const resultado = await pool.query(`
      SELECT c.id AS cliente_id, c.nombre, c.telefono, mc.moneda,
        COALESCE(SUM(CASE WHEN mc.tipo = 'cargo' THEN mc.monto ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN mc.tipo = 'abono' THEN mc.monto ELSE 0 END), 0) AS saldo_pendiente
      FROM movimientos_cuenta mc
      JOIN clientes c ON c.id = mc.cliente_id
      GROUP BY c.id, c.nombre, c.telefono, mc.moneda
      HAVING COALESCE(SUM(CASE WHEN mc.tipo = 'cargo' THEN mc.monto ELSE 0 END), 0) -
             COALESCE(SUM(CASE WHEN mc.tipo = 'abono' THEN mc.monto ELSE 0 END), 0) > 0.01
      ORDER BY c.nombre ASC
    `);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar fiados pendientes', error: error.message });
  }
}

async function resumenFiados(req, res) {
  try {
    const resultado = await pool.query(`
      SELECT moneda, SUM(saldo) AS total_pendiente, COUNT(DISTINCT cliente_id) AS clientes_con_deuda
      FROM (
        SELECT c.id AS cliente_id, mc.moneda,
          COALESCE(SUM(CASE WHEN mc.tipo = 'cargo' THEN mc.monto ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN mc.tipo = 'abono' THEN mc.monto ELSE 0 END), 0) AS saldo
        FROM movimientos_cuenta mc
        JOIN clientes c ON c.id = mc.cliente_id
        GROUP BY c.id, mc.moneda
        HAVING COALESCE(SUM(CASE WHEN mc.tipo = 'cargo' THEN mc.monto ELSE 0 END), 0) -
               COALESCE(SUM(CASE WHEN mc.tipo = 'abono' THEN mc.monto ELSE 0 END), 0) > 0.01
      ) sub
      GROUP BY moneda
    `);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen de fiados', error: error.message });
  }
}

module.exports = {
  listarClientes,
  buscarClientes,
  crearCliente,
  obtenerEstadoCuenta,
  registrarAbono,
  listarFiadosPendientes,
  resumenFiados
};