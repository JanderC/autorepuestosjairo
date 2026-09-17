const { redondear } = require('./redondeo');

function convertirAUSD(monto, moneda, tasa) {
  const montoNum = Number(monto);
  switch (moneda) {
    case 'USD':
      return montoNum;
    case 'COP':
      return montoNum / Number(tasa.usd_cop);
    case 'BS': {
      const usdBsEfectivo = tasa.bs_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.bs_cop)
        : Number(tasa.usd_bs);
      return montoNum / usdBsEfectivo;
    }
    default:
      throw new Error('Moneda no soportada');
  }
}

function convertirDesdeUSD(montoUSD, moneda, tasa) {
  const monto = Number(montoUSD);
  switch (moneda) {
    case 'USD':
      return monto;
    case 'COP':
      return monto * Number(tasa.usd_cop);
    case 'BS': {
      const usdBsEfectivo = tasa.bs_cop_manual
        ? Number(tasa.usd_cop) / Number(tasa.bs_cop)
        : Number(tasa.usd_bs);
      return monto * usdBsEfectivo;
    }
    default:
      throw new Error('Moneda no soportada');
  }
}

// Convierte entre 2 monedas cualquiera. Si son la misma, devuelve el monto TAL CUAL (sin ninguna
// operación matemática) — esto es lo que elimina el error de decimales cuando se vende y se paga
// en la misma moneda, que es el caso más común.
function convertirEntreMonedas(monto, monedaOrigen, monedaDestino, tasa) {
  if (monedaOrigen === monedaDestino) return Number(monto);
  const usd = convertirAUSD(monto, monedaOrigen, tasa);
  return convertirDesdeUSD(usd, monedaDestino, tasa);
}

function precioEfectivoEnMoneda(producto, monedaDestino, tasa) {
  if (monedaDestino === producto.moneda_base) {
    return Number(producto.precio_venta);
  }
  const manualDestino = producto[`precio_manual_${monedaDestino.toLowerCase()}`];
  if (manualDestino != null) {
    return Number(manualDestino);
  }
  if (monedaDestino === 'BS' && producto.precio_manual_cop != null) {
    return convertirEntreMonedas(producto.precio_manual_cop, 'COP', 'BS', tasa);
  }
  if (monedaDestino === 'COP' && producto.precio_manual_bs != null) {
    return convertirEntreMonedas(producto.precio_manual_bs, 'BS', 'COP', tasa);
  }
  return convertirEntreMonedas(producto.precio_venta, producto.moneda_base, monedaDestino, tasa);
}

module.exports = { convertirAUSD, convertirDesdeUSD, convertirEntreMonedas, precioEfectivoEnMoneda, redondear };