const cron = require('node-cron');
const { obtenerYGuardarTasaBCV } = require('../modules/tasas/tasas.controller');

function iniciarCronTasas() {
  cron.schedule('0 8 * * *', async () => {
    try {
      const tasa = await obtenerYGuardarTasaBCV();
      console.log(`[CRON] Tasa actualizada automáticamente: USD/BS=${tasa.usd_bs}, USD/COP=${tasa.usd_cop}`);
    } catch (error) {
      console.error('[CRON] Error al actualizar tasa automática:', error.message);
    }
  });

  console.log('Cron job de tasas programado: todos los días a las 8:00 AM');
}

module.exports = iniciarCronTasas;