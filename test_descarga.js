const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yts = require('yt-search');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function testDescarga() {
  const busqueda = 'mar azul natanael cano';
  console.log(`[Test] Iniciando prueba para: "${busqueda}"`);

  // 1. yt-search
  const consultaBusqueda = `${busqueda} audio oficial`;
  console.log(`[Paso 1] Buscando en YouTube: "${consultaBusqueda}"...`);
  const searchResult = await yts(consultaBusqueda);
  const videos = searchResult && searchResult.videos ? searchResult.videos : [];
  const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
    || videos.find((v) => v.seconds > 60)
    || videos[0];

  if (!video) {
    throw new Error('No se encontró el video en YouTube');
  }

  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
  const trackTitle = video.title || busqueda;
  console.log(`[Paso 1 Éxito] Video encontrado: "${trackTitle}" (${video.timestamp || video.seconds + 's'}) -> ${videoUrl}`);

  // 2. Cobalt instances
  let streamUrl = null;
  const cobaltInstances = [
    'https://cobalt-api.kwiatekm.tokyo/',
    'https://api.cobalt.0011001100.xyz/',
    'https://cobalt.tools.api.alextesting.ninja/',
    'https://api.savefrom.net/'
  ];

  for (const cobaltUrl of cobaltInstances) {
    try {
      console.log(`[Paso 2] Probando Cobalt: ${cobaltUrl}...`);
      const cRes = await axios.post(cobaltUrl, {
        url: videoUrl,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': UA
        },
        timeout: 6000,
        validateStatus: () => true
      });

      console.log(`  Respuesta Cobalt (${cobaltUrl}): status=${cRes.status}, data=`, JSON.stringify(cRes.data).substring(0, 150));
      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        streamUrl = cRes.data.url;
        console.log(`[Cobalt Éxito]: Stream obtenido desde ${cobaltUrl}`);
        break;
      }
    } catch (e) {
      console.log(`  Cobalt error (${cobaltUrl}):`, e.message);
    }
  }

  // 3. Fallback
  if (!streamUrl) {
    console.log(`[Paso 3] Cobalt no disponible, probando fallback a extractor directo...`);
    const dominiosExtractor = [
      'https://p.savenow.to',
      'https://p.lbserver.xyz'
    ];

    for (const dominio of dominiosExtractor) {
      try {
        console.log(`  Probando extractor: ${dominio}...`);
        const startRes = await axios.get(`${dominio}/api/v2/download`, {
          params: { button: 1, format: 'mp3', url: videoUrl },
          headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
          timeout: 8000
        });

        if (startRes.data && startRes.data.id) {
          const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;
          console.log(`  Esperando progreso id=${startRes.data.id}...`);

          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const pRes = await axios.get(progressUrl, {
              headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
              timeout: 8000
            });

            console.log(`    Progreso: ${pRes.data.progress || 0}%, success: ${pRes.data.success}`);
            if (pRes.data && pRes.data.success === 1 && pRes.data.download_url) {
              streamUrl = pRes.data.download_url;
              console.log(`[Extractor Directo Éxito]: Audio MP3 preparado en ${dominio}`);
              break;
            }
            if (pRes.data && pRes.data.text && pRes.data.text.toLowerCase().includes('error')) {
              break;
            }
          }
        }
        if (streamUrl) break;
      } catch (err) {
        console.log(`  Extractor error (${dominio}):`, err.message);
      }
    }
  }

  if (!streamUrl) {
    throw new Error('No se pudo obtener URL de descarga de ninguna fuente.');
  }

  // 4. Descargar archivo y comprobar peso
  console.log(`[Paso 4] Descargando stream desde: ${streamUrl.substring(0, 80)}...`);
  const outputPath = path.join(__dirname, 'prueba_mar_azul.mp3');
  const response = await axios({
    method: 'get',
    url: streamUrl,
    responseType: 'stream',
    timeout: 45000,
    headers: { 'User-Agent': UA }
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const stats = fs.statSync(outputPath);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`\n========================================`);
  console.log(`ARCHIVO DESCARGADO EXITOSAMENTE:`);
  console.log(`Ruta: ${outputPath}`);
  console.log(`Tamaño: ${stats.size} bytes (${sizeMB} MB)`);
  console.log(`Canción: "${trackTitle}"`);
  console.log(`========================================\n`);

  if (stats.size > 2 * 1024 * 1024) {
    console.log(`✅ VERIFICACIÓN PASADA: El archivo pesa más de 2 MB (${sizeMB} MB).`);
  } else {
    console.error(`❌ VERIFICACIÓN FALLIDA: El archivo pesa menos de 2 MB (${sizeMB} MB).`);
    process.exit(1);
  }
}

testDescarga().catch((err) => {
  console.error('Error en prueba:', err.message);
  process.exit(1);
});
