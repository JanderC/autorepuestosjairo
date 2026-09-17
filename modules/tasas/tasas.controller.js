const pool = require('../../config/db');
const axios = require('axios');

function numeroValido(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0;
}

async function obtenerTasaActual(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'No hay tasa registrada' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener tasa actual', error: error.message });
  }
}

async function listarHistorial(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 90'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar historial de tasas', error: error.message });
  }
}

// usd_bs y usd_cop ahora son OPCIONALES: si no vienen, se mantiene el último valor conocido.
// bs_cop (el cruce peso-bolívar que realmente se usa día a día) se puede actualizar solo,
// sin tocar nada más.
async function registrarTasaManual(req, res) {
  const { usd_bs, usd_cop, bs_cop } = req.body;

  try {
    const anterior = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    const previa = anterior.rows[0] || null;

    const usdBsFinal = usd_bs != null && usd_bs !== '' ? Number(usd_bs) : previa ? Number(previa.usd_bs) : null;
    const usdCopFinal = usd_cop != null && usd_cop !== '' ? Number(usd_cop) : previa ? Number(previa.usd_cop) : null;

    if (!numeroValido(usdBsFinal) || !numeroValido(usdCopFinal)) {
      return res.status(400).json({
        message: 'No hay una tasa previa registrada: la primera vez tenés que indicar usd_bs y usd_cop.'
      });
    }

    let bsCopFinal;
    let bsCopManual;
    if (bs_cop != null && bs_cop !== '') {
      if (!numeroValido(bs_cop)) {
        return res.status(400).json({ message: 'bs_cop debe ser un número mayor a 0' });
      }
      bsCopFinal = Number(bs_cop);
      bsCopManual = true;
    } else {
      bsCopFinal = usdCopFinal / usdBsFinal;
      bsCopManual = false;
    }

    const resultado = await pool.query(
      `INSERT INTO tasas_cambio (fecha, usd_bs, usd_cop, bs_cop, fuente, bs_cop_manual)
       VALUES (CURRENT_DATE, $1, $2, $3, 'Manual', $4)
       RETURNING *`,
      [usdBsFinal, usdCopFinal, bsCopFinal, bsCopManual]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar tasa manual', error: error.message });
  }
}

// Consulta dolarapi.com y guarda la tasa del día. Si el servicio externo no responde con
// datos válidos, NO inserta nada — devuelve un error claro en vez de romper por NOT NULL.
async function obtenerYGuardarTasaBCV() {
  const [respuestaVe, respuestaCo] = await Promise.all([
    axios.get('https://ve.dolarapi.com/v1/dolares/oficial'),
    axios.get('https://co.dolarapi.com/v1/cotizaciones/usd')
  ]);

  const usd_bs = respuestaVe.data?.promedio;
  const usd_cop = respuestaCo.data?.valor;

  if (!numeroValido(usd_bs) || !numeroValido(usd_cop)) {
    throw new Error(
      'El servicio de tasas automáticas no devolvió valores válidos (puede haber cambiado su formato). Por ahora registrá la tasa manualmente.'
    );
  }

  // Si el negocio ya está manejando el cruce peso-bolívar a mano, el auto-update de USD
  // no debe pisarlo — solo actualiza las referencias en dólares.
  const anterior = await pool.query(
    'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
  );
  const previa = anterior.rows[0] || null;
  const usaManual = previa?.bs_cop_manual === true;
  const bs_cop = usaManual ? Number(previa.bs_cop) : Number(usd_cop) / Number(usd_bs);

  const resultado = await pool.query(
    `INSERT INTO tasas_cambio (fecha, usd_bs, usd_cop, bs_cop, fuente, bs_cop_manual)
     VALUES (CURRENT_DATE, $1, $2, $3, 'BCV', $4)
     RETURNING *`,
    [usd_bs, usd_cop, bs_cop, usaManual]
  );

  return resultado.rows[0];
}

async function actualizarTasaAutomatica(req, res) {
  try {
    const tasa = await obtenerYGuardarTasaBCV();
    res.status(201).json(tasa);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Error al actualizar tasa automática' });
  }
}

async function actualizarBsCopManual(req, res) {
  const { bs_cop } = req.body;

  if (!numeroValido(bs_cop)) {
    return res.status(400).json({ message: 'bs_cop es requerido y debe ser mayor a 0' });
  }

  try {
    const actual = await pool.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (actual.rows.length === 0) {
      return res.status(404).json({ message: 'No hay tasa registrada para actualizar' });
    }

    const resultado = await pool.query(
      `UPDATE tasas_cambio SET bs_cop = $1, bs_cop_manual = true WHERE id = $2 RETURNING *`,
      [bs_cop, actual.rows[0].id]
    );
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cruce BS/COP', error: error.message });
  }
}

async function restablecerBsCop(req, res) {
  try {
    const actual = await pool.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (actual.rows.length === 0) {
      return res.status(404).json({ message: 'No hay tasa registrada para restablecer' });
    }
    const tasa = actual.rows[0];
    const bsCopCalculado = Number(tasa.usd_cop) / Number(tasa.usd_bs);

    const resultado = await pool.query(
      `UPDATE tasas_cambio SET bs_cop = $1, bs_cop_manual = false WHERE id = $2 RETURNING *`,
      [bsCopCalculado, tasa.id]
    );
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al restablecer cruce BS/COP', error: error.message });
  }
}

module.exports = {
  obtenerTasaActual,
  listarHistorial,
  registrarTasaManual,
  actualizarTasaAutomatica,
  actualizarBsCopManual,
  restablecerBsCop,
  obtenerYGuardarTasaBCV
};