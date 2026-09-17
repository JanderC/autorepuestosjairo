function generarCodigoProducto() {
  const timestamp = Date.now().toString().slice(-8); // últimos 8 dígitos del tiempo actual
  const random = Math.floor(1000 + Math.random() * 9000); // 4 dígitos aleatorios
  return `PRD-${timestamp}-${random}`;
}

module.exports = generarCodigoProducto;