// Modo A: se da precio_compra + porcentaje → calcula precio_venta
function calcularPreciosYGanancia({ precio_compra, precio_venta, porcentaje_ganancia }) {
  const compra = Number(precio_compra);

  if (porcentaje_ganancia != null && porcentaje_ganancia !== '') {
    // Modo A: el % manda, se recalcula precio_venta
    const porcentaje = Number(porcentaje_ganancia);
    const ventaCalculada = compra + (compra * porcentaje) / 100;
    return {
      precio_venta: Number(ventaCalculada.toFixed(2)),
      porcentaje_ganancia: porcentaje
    };
  }

  // Modo B: ambos precios vienen manuales, se calcula el % resultante
  const venta = Number(precio_venta);
  const porcentajeCalculado = compra > 0 ? ((venta - compra) / compra) * 100 : 0;
  return {
    precio_venta: venta,
    porcentaje_ganancia: Number(porcentajeCalculado.toFixed(2))
  };
}

module.exports = { calcularPreciosYGanancia };