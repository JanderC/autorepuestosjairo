function redondear(numero, decimales = 2) {
  if (numero == null || isNaN(numero)) return 0;
  const factor = Math.pow(10, decimales);
  return Math.round((Number(numero) + Number.EPSILON) * factor) / factor;
}

module.exports = { redondear };