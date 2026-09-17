// Devuelve 'YYYY-MM-DD' según la hora de Venezuela, sin importar la zona horaria del navegador
export function obtenerFechaVenezuela(fecha = new Date()) {
  return new Date(fecha).toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
}

export function filtrarVentasDeHoy(ventas) {
  const hoy = obtenerFechaVenezuela();
  return ventas.filter((v) => obtenerFechaVenezuela(v.fecha) === hoy);
}