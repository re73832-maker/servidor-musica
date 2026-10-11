const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = require('./index');

async function testServidorLocal() {
  const puertoTest = 4999;
  const servidor = app.listen(puertoTest, async () => {
    console.log(`[Test] Servidor local escuchando en http://localhost:${puertoTest}`);
    try {
      const cancion = 'mar azul natanael cano';
      console.log(`[Test] Solicitando /descargar?q=${encodeURIComponent(cancion)}...`);

      const resp = await axios.get(`http://localhost:${puertoTest}/descargar`, {
        params: { q: cancion },
        responseType: 'arraybuffer',
        timeout: 90000,
        validateStatus: () => true
      });

      console.log(`[Test] Respuesta HTTP: ${resp.status}`);
      console.log(`[Test] Content-Type: ${resp.headers['content-type']}`);
      console.log(`[Test] Content-Length: ${resp.headers['content-length']}`);

      if (resp.status !== 200) {
        const errorText = Buffer.from(resp.data).toString('utf-8');
        throw new Error(`Servidor devolvió status ${resp.status}: ${errorText}`);
      }

      const buffer = Buffer.from(resp.data);
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      console.log(`[Test] Tamaño recibido: ${buffer.length} bytes (${sizeMB} MB)`);

      if (buffer.length >= 2 * 1024 * 1024) {
        console.log(`✅ VERIFICACIÓN PASADA: El archivo pesa más de 2 MB (${sizeMB} MB) y no es HTML/captcha.`);
      } else {
        throw new Error(`❌ FALLO: El archivo pesa menos de 2 MB (${sizeMB} MB).`);
      }

      servidor.close(() => {
        console.log('[Test] Servidor de prueba cerrado.');
        process.exit(0);
      });
    } catch (err) {
      console.error('[Test Error]:', err.message);
      servidor.close(() => process.exit(1));
    }
  });
}

testServidorLocal();
