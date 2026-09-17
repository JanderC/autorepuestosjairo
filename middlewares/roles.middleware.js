function verificarRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ message: 'No tienes permisos para esta acción' });
    }
    next();
  };
}

module.exports = verificarRol;