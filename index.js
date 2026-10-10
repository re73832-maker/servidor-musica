const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

// Middleware y CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges']
}));

app.use(express.json());

// Endpoint de chequeo de salud y actividad para Render
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    port: PUERTO,
    engine: 'yt-search + cobalt / invidious streaming (sin yt-dlp ni ffmpeg)'
  });
});

/**
 * Motor de descarga definitivo sin yt-dlp ni ffmpeg:
 * 1. Busca con yt-search seleccionando video completo (duración > 60s).
 * 2. Intenta Cobalt API para stream directo.
 * 3. Fallback a Invidious (API estructurada o endpoint latest_version).
 * 4. Envía stream directo a res con Content-Type: audio/mpeg y Accept-Ranges: bytes.
 * 5. Cierra conexiones limpiamente y maneja errores sin bloquear el servidor.
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Petición de audio recibida: "${busqueda}"`);

  let audioStream = null;

  // Manejo de desconexión del cliente
  res.on('close', () => {
    if (audioStream && typeof audioStream.destroy === 'function') {
      audioStream.destroy();
    }
  });

  try {
    // 1. Buscar el video solicitado con yt-search
    console.log(`[Paso 1/3]: Buscando pista en YouTube con yt-search...`);
    const searchResult = await yts(busqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];

    // Seleccionar el primer resultado que sea video completo (> 60s) o el primer resultado
    const video = videos.find((v) => v.seconds > 60) || videos[0];

    if (!video) {
      console.warn(`[Aviso]: No se encontraron resultados para "${busqueda}".`);
      return res.status(404).json({ error: 'No se encontraron resultados para la búsqueda solicitada.' });
    }

    console.log(`[Video Seleccionado]: "${video.title}" (${video.duration ? video.duration.timestamp : video.seconds + 's'}) - ${video.url}`);

    let streamUrl = null;

    // 2. Obtener stream con Cobalt API
    const cobaltInstances = [
      'https://api.cobalt.tools/',
      'https://cobalt.clxxped.lol/',
      'https://cobalt.meowing.de/',
      'https://cobalt.canine.tools/'
    ];

    for (const cobaltApi of cobaltInstances) {
      try {
        console.log(`[Paso 2/3]: Solicitando audio a Cobalt API (${cobaltApi})...`);
        const cobaltRes = await axios.post(cobaltApi, {
          url: video.url,
          downloadMode: 'audio',
          audioFormat: 'mp3'
        }, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          timeout: 6000
        });

        if (cobaltRes.data && (cobaltRes.data.status === 'tunnel' || cobaltRes.data.status === 'redirect' || cobaltRes.data.url)) {
          streamUrl = cobaltRes.data.url;
          console.log(`[Cobalt Éxito]: Stream obtenido desde ${cobaltApi}`);
          break;
        }
      } catch (errCobalt) {
        // Continuar con la siguiente opción
      }
    }

    // 3. Fallback: Invidious Audio Stream
    if (!streamUrl) {
      console.log(`[Paso 3/3]: Cobalt no entregó stream. Activando Fallback con Invidious...`);

      const invidiousApiHosts = [
        'https://invidious.f5.si',
        'https://invidious.nerdvpn.de',
        'https://inv.nadeko.net'
      ];

      for (const host of invidiousApiHosts) {
        try {
          const invRes = await axios.get(`${host}/api/v1/videos/${video.videoId}`, {
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });

          if (invRes.data && Array.isArray(invRes.data.adaptiveFormats)) {
            const audioFormat = invRes.data.adaptiveFormats.find((f) => f.type && f.type.includes('audio') && (f.itag === '140' || f.itag === 140))
              || invRes.data.adaptiveFormats.find((f) => f.type && f.type.includes('audio') && f.url);

            if (audioFormat && audioFormat.url) {
              streamUrl = audioFormat.url;
              console.log(`[Invidious Éxito]: Stream de audio obtenido desde ${host}`);
              break;
            }
          }
        } catch (_) {}
      }

      // Endpoint directo latest_version si la API adaptativa no respondió
      if (!streamUrl) {
        const directList = [
          `https://inv.nadeko.net/latest_version?id=${video.videoId}&itag=140`,
          `https://invidious.f5.si/latest_version?id=${video.videoId}&itag=140`,
          `https://invidious.nerdvpn.de/latest_version?id=${video.videoId}&itag=140`
        ];

        for (const candidate of directList) {
          try {
            const headRes = await axios.head(candidate, {
              timeout: 4000,
              maxRedirects: 5,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            if (headRes.status >= 200 && headRes.status < 400) {
              streamUrl = candidate;
              console.log(`[Invidious Directo Éxito]: Stream verificado en ${candidate}`);
              break;
            }
          } catch (_) {}
        }
      }
    }

    // 4. Si se obtuvo la URL del stream, conectar y hacer pipe a res
    if (streamUrl) {
      console.log(`[Conectando Stream]: Solicitando stream de audio...`);

      const audioResponse = await axios({
        method: 'get',
        url: streamUrl,
        responseType: 'stream',
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });

      audioStream = audioResponse.data;

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(video.title || busqueda)}.mp3"`);
      res.setHeader('Cache-Control', 'no-cache');

      if (audioResponse.headers['content-length']) {
        res.setHeader('Content-Length', audioResponse.headers['content-length']);
      }

      console.log(`[TRANSMITIENDO]: Enviando stream de audio al cliente...`);
      audioResponse.data.pipe(res);

      audioResponse.data.on('end', () => {
        console.log(`[ÉXITO]: Stream de "${video.title}" entregado completamente al cliente.`);
      });

      audioResponse.data.on('error', (errStream) => {
        console.error(`[Error en audio stream]:`, errStream.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error durante la transmisión del stream de audio' });
        }
      });

      return;
    }

    // Si fallaron todas las fuentes
    console.error(`[Fallo Total]: No se pudo obtener stream de audio para "${busqueda}".`);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'No se pudo obtener el stream de audio para esta pista. Intenta con otro término.'
      });
    }

  } catch (errorGeneral) {
    console.error(`[Error General en /descargar]:`, errorGeneral.message || errorGeneral);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Error interno del servidor al procesar la descarga de audio.'
      });
    }
  }
}

// Rutas de API
app.get('/descargar', manejarDescargaAudio);
app.get('/buscar', manejarDescargaAudio);
app.get('/stream', manejarDescargaAudio);

// Servir archivos estáticos del frontend compilado
app.use(express.static(RUTA_DIST));

// Fallback para SPA y PWA
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

app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(` Servidor Express Activo en Puerto ${PUERTO}`);
  console.log(` Aplicación web y API: http://localhost:${PUERTO}`);
  console.log(` Frontend estático: ${RUTA_DIST}`);
  console.log(` Motor: yt-search + Cobalt API + Invidious Stream`);
  console.log(` (Sin yt-dlp ni FFmpeg - Cero consumo de RAM excesivo)`);
  console.log(`=======================================================`);
});