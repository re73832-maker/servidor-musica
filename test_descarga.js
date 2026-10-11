const axios = require('axios');
const app = require('./index');

async function testProxyStreamFlow() {
  const puertoTest = 4997;
  const servidor = app.listen(puertoTest, async () => {
    console.log(`[Test] Servidor activo en http://localhost:${puertoTest}`);
    try {
      const cancion = 'mar azul natanael cano';
      console.log(`[Paso 1 Frontend]: Obteniendo enlace para "${cancion}"...`);

      const resEnlace = await axios.get(`http://localhost:${puertoTest}/api/obtener-enlace`, {
        params: { q: cancion },
        timeout: 45000
      });

      console.log('[Paso 1 Éxito]:', resEnlace.data);
      const { downloadUrl, titulo, duracion } = resEnlace.data;

      if (!downloadUrl) {
        throw new Error('No se recibió downloadUrl');
      }

      console.log(`[Paso 2 Frontend]: Descargando a través del proxy /api/proxy-stream...`);
      const proxyUrl = `http://localhost:${puertoTest}/api/proxy-stream?url=${encodeURIComponent(downloadUrl)}`;

      const resProxy = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: 60000
      });

      console.log(`[Paso 2 Éxito]: Status HTTP: ${resProxy.status}`);
      console.log(`[Paso 2 Éxito]: CORS header: ${resProxy.headers['access-control-allow-origin']}`);
      console.log(`[Paso 2 Éxito]: Content-Type: ${resProxy.headers['content-type']}`);

      const buffer = Buffer.from(resProxy.data);
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      console.log(`[Paso 2 Éxito]: Bytes recibidos: ${buffer.length} (${sizeMB} MB)`);

      if (buffer.length >= 2 * 1024 * 1024) {
        console.log(`\n======================================================`);
        console.log(`✅ VERIFICACIÓN PASADA: Audio transmitido por proxy sin CORS.`);
        console.log(`Título: "${titulo}" | Tamaño: ${sizeMB} MB > 2 MB`);
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

testProxyStreamFlow();
