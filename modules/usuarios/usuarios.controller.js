const pool = require('../../config/db');
const bcrypt = require('bcryptjs');

async function listarUsuarios(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT id, nombre, email, rol, activo, created_at FROM usuarios ORDER BY nombre ASC'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar usuarios', error: error.message });
  }
}

async function crearUsuario(req, res) {
  const { nombre, email, contraseña, rol } = req.body;

  if (!nombre || !email || !contraseña || !rol) {
    return res.status(400).json({ message: 'Nombre, email, contraseña y rol son requeridos' });
  }
  if (!['admin', 'cajero'].includes(rol)) {
    return res.status(400).json({ message: 'Rol inválido' });
  }

  try {
    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya existe un usuario con ese email' });
    }

    const hash = await bcrypt.hash(contraseña, 10);

    const resultado = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol, activo, created_at`,
      [nombre, email, hash, rol]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear usuario', error: error.message });
  }
}

async function editarUsuario(req, res) {
  const { id } = req.params;
  const { nombre, email, contraseña, rol } = req.body;

  try {
    const actualResultado = await pool.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (actualResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    const actual = actualResultado.rows[0];

    let passwordHashFinal = actual.password_hash;
    if (contraseña) {
      passwordHashFinal = await bcrypt.hash(contraseña, 10);
    }

    const resultado = await pool.query(
      `UPDATE usuarios SET
        nombre = COALESCE($1, nombre),
        email = COALESCE($2, email),
        rol = COALESCE($3, rol),
        password_hash = $4
       WHERE id = $5
       RETURNING id, nombre, email, rol, activo, created_at`,
      [nombre, email, rol, passwordHashFinal, id]
    );

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al editar usuario', error: error.message });
  }
}

async function cambiarEstadoUsuario(req, res) {
  const { id } = req.params;
  const { activo } = req.body;

  if (activo == null) {
    return res.status(400).json({ message: 'El campo activo es requerido' });
  }

  try {
    const resultado = await pool.query(
      `UPDATE usuarios SET activo = $1 WHERE id = $2 RETURNING id, nombre, email, rol, activo`,
      [activo, id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar estado del usuario', error: error.message });
  }
}

module.exports = { listarUsuarios, crearUsuario, editarUsuario, cambiarEstadoUsuario };