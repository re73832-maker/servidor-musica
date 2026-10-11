const axios = require('axios');
const app = require('./index');

async function testFlujoCompleto() {
  const puertoTest = 4998;
  const servidor = app.listen(puertoTest, async () => {
    console.log(`[Test] Servidor local activo en http://localhost:${puertoTest}`);
    try {
      const cancion = 'mar azul natanael cano';
      console.log(`[Paso 1 Client]: Llamando a /api/obtener-enlace?q=${encodeURIComponent(cancion)}...`);

      const resEnlace = await axios.get(`http://localhost:${puertoTest}/api/obtener-enlace`, {
        params: { q: cancion },
        timeout: 45000
      });

      console.log('[Paso 1 Éxito]: Respuesta JSON recibida:', resEnlace.data);
      const { downloadUrl, titulo, duracion } = resEnlace.data;

      if (!downloadUrl) {
        throw new Error('No se recibió downloadUrl en la respuesta JSON');
      }

      console.log(`[Paso 2 Client]: Simulando descarga directa desde navegador a ${downloadUrl.substring(0, 80)}...`);

      const resAudio = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 45000
      });

      console.log(`[Paso 2 Éxito]: Status HTTP: ${resAudio.status}`);
      console.log(`[Paso 2 Éxito]: Content-Type: ${resAudio.headers['content-type']}`);

      const buffer = Buffer.from(resAudio.data);
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      console.log(`[Paso 2 Éxito]: Tamaño del archivo descargado: ${buffer.length} bytes (${sizeMB} MB)`);

      if (buffer.length >= 2 * 1024 * 1024) {
        console.log(`\n======================================================`);
        console.log(`✅ VERIFICACIÓN PASADA: Canción oficial descargada (${sizeMB} MB > 2 MB).`);
        console.log(`Título: "${titulo}" | Duración: ${duracion}s`);
        console.log(`======================================================\n`);
      } else {
        throw new Error(`❌ Tamaño insuficiente (${sizeMB} MB < 2 MB)`);
      }

      servidor.close(() => process.exit(0));
    } catch (e) {
      console.error('[Error en Test]:', e.message);
      servidor.close(() => process.exit(1));
    }
  });
}

testFlujoCompleto();
