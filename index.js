const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Middleware y CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Titulo-Audio']
}));

app.use(express.json());

// Endpoint de chequeo de salud / actividad para Render
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    port: PUERTO,
    engine: 'yt-search + cobalt / direct mp3 extraction stream'
  });
});

/**
 * Endpoint /descargar:
 * 1. Búsqueda de video oficial con yt-search (duración 1:30 a 8:00).
 * 2. Cascadas de instancias Cobalt (sin JWT) y fallback al extractor directo de MP3.
 * 3. Streaming directo al cliente con Content-Type: audio/mpeg y Content-Disposition inline.
 * 4. Manejo limpio del ciclo de vida y cierre de conexiones.
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud de descarga oficial: "${busqueda}"`);

  let audioStreamAxios = null;

  // Manejo de desconexión del cliente
  res.on('close', () => {
    if (audioStreamAxios && typeof audioStreamAxios.destroy === 'function') {
      audioStreamAxios.destroy();
    }
  });

  try {
    // 1. Búsqueda oficial con yt-search
    console.log(`[Paso 1/3]: Buscando versión oficial en YouTube...`);
    const consultaBusqueda = `${busqueda} audio oficial`;
    const searchResult = await yts(consultaBusqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];

    // Seleccionar el video oficial con duración entre 1:30 (90s) y 8:00 (480s)
    const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
      || videos.find((v) => v.seconds > 60)
      || videos[0];

    if (!video) {
      console.warn(`[Aviso]: No se encontraron videos para "${busqueda}".`);
      return res.status(404).json({ error: 'No se encontró el video oficial en YouTube.' });
    }

    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const trackTitle = video.title || busqueda;
    console.log(`[Video Oficial]: "${trackTitle}" (${video.timestamp || video.seconds + 's'}) -> ${videoUrl}`);

    let streamUrl = null;

    // 2. Cascadas de instancias públicas de Cobalt (sin JWT)
    const cobaltInstances = [
      'https://cobalt-api.kwiatekm.tokyo/',
      'https://api.cobalt.0011001100.xyz/',
      'https://cobalt.tools.api.alextesting.ninja/',
      'https://api.savefrom.net/'
    ];

    for (const cobaltUrl of cobaltInstances) {
      try {
        console.log(`[Paso 2/3]: Probando instancia Cobalt: ${cobaltUrl}...`);
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
          timeout: 4000,
          validateStatus: () => true
        });

        if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
          streamUrl = cRes.data.url;
          console.log(`[Cobalt Éxito]: Stream obtenido desde ${cobaltUrl}`);
          break;
        }
      } catch (_) {
        // Salta inmediatamente a la siguiente de la lista si falla o pide autenticación
      }
    }

    // 3. Fallback a endpoint de extracción directa de MP3 oficial
    if (!streamUrl) {
      console.log(`[Fallback]: Cobalt no disponible -> Usando extractor directo de MP3 oficial...`);

      const dominiosExtractor = [
        'https://p.savenow.to',
        'https://p.lbserver.xyz'
      ];

      for (const dominio of dominiosExtractor) {
        try {
          const startRes = await axios.get(`${dominio}/api/v2/download`, {
            params: { button: 1, format: 'mp3', url: videoUrl },
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            timeout: 8000
          });

          if (startRes.data && startRes.data.id) {
            const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

            // Consultar progreso hasta que esté listo el streamUrl
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 1500));
              if (res.writableEnded || req.socket.destroyed) return;

              const pRes = await axios.get(progressUrl, {
                headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
                timeout: 8000
              });

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
        } catch (_) {}
      }
    }

    // 4. Streaming directo al cliente
    if (streamUrl) {
      console.log(`[TRANSMITIENDO]: Conectando stream de audio hacia el cliente...`);

      const audioResponse = await axios({
        method: 'get',
        url: streamUrl,
        responseType: 'stream',
        timeout: 30000,
        headers: { 'User-Agent': UA }
      });

      audioStreamAxios = audioResponse.data;

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(trackTitle)}.mp3"`);
      res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
      res.setHeader('Cache-Control', 'no-cache');

      if (audioResponse.headers['content-length']) {
        res.setHeader('Content-Length', audioResponse.headers['content-length']);
      }

      audioResponse.data.pipe(res);

      audioResponse.data.on('end', () => {
        console.log(`[ÉXITO]: Audio oficial de "${trackTitle}" entregado completamente al cliente.`);
      });

      audioResponse.data.on('error', (errStream) => {
        console.error(`[Error Stream]:`, errStream.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error durante la transmisión del stream de audio' });
        }
      });

      return;
    }

    // Si fallaron todas las instancias y fallbacks
    console.error(`[Fallo Definitivo]: No se pudo obtener el audio oficial de YouTube para "${busqueda}".`);
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'No se pudo obtener el flujo de audio oficial de YouTube de ningún proveedor disponible.'
      });
    }

  } catch (errorGeneral) {
    console.error(`[Error no controlado]:`, errorGeneral.message || errorGeneral);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Error interno al procesar la descarga del audio oficial.'
      });
    }
  }
}

// Rutas de API
app.get('/descargar', manejarDescargaAudio);
app.get('/buscar', manejarDescargaAudio);
app.get('/stream', manejarDescargaAudio);

// Servir estáticos de la PWA compilada
app.use(express.static(RUTA_DIST));

// Fallback SPA/PWA
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }

  const archivoIndex = path.join(RUTA_DIST, 'index.html');
  if (fs.existsSync(archivoIndex)) {
    return res.sendFile(archivoIndex);
  }

  res.status(404).send('No se encontró el archivo index.html en dist');
});

if (require.main === module) {
  app.listen(PUERTO, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` Servidor Express Activo en Puerto ${PUERTO}`);
    console.log(` Descarga Oficial de YouTube (Cobalt + Fallback Directo)`);
    console.log(` Aplicación web y API: http://localhost:${PUERTO}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;