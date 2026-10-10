const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

// Middleware y cabeceras CORS
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
    ffmpeg: ffmpeg.path ? 'disponible' : 'no encontrado'
  });
});

/**
 * Descarga de audio optimizada para Render y centros de datos:
 * 1. Prioriza SoundCloud (scsearch) porque NO bloquea las IPs de Render ni requiere login.
 * 2. Si SoundCloud falla, recurre a YouTube utilizando los clientes móviles (ios, android) para evitar bloqueos web.
 * 3. Descarga con formato nativo de mejor audio (-f "ba/bestaudio/best") y extrae a MP3 mediante FFmpeg estático.
 * 4. Valida tamaño > 200 KB, envía con res.sendFile y elimina el archivo temporal tras 'finish'.
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  const idTemp = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const archivoTemp = path.join(os.tmpdir(), `${idTemp}.mp3`);

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Petición de descarga: "${busqueda}"`);
  console.log(`[Archivo Temporal]: ${archivoTemp}`);

  const eliminarArchivoTemporal = () => {
    try {
      if (fs.existsSync(archivoTemp)) {
        fs.unlink(archivoTemp, (err) => {
          if (!err) {
            console.log(`[Limpieza]: Archivo temporal eliminado correctamente.`);
          }
        });
      }
    } catch (_) {}
  };

  // Eliminar el archivo si el cliente cancela o desconecta la petición antes de tiempo
  res.on('close', () => {
    if (!res.writableEnded) {
      eliminarArchivoTemporal();
    }
  });

  try {
    let exito = false;

    // -------------------------------------------------------------
    // PASO 1: PRIORIDAD SOUNDCLOUD (Evita bloqueos de IP en Render)
    // -------------------------------------------------------------
    try {
      console.log(`[Paso 1/2]: Buscando y descargando desde SoundCloud...`);
      await ytdlp(`scsearch5:${busqueda}`, {
        format: 'ba/bestaudio/best',
        extractAudio: true,
        audioFormat: 'mp3',
        ffmpegLocation: ffmpeg.path,
        output: archivoTemp,
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        maxDownloads: 1,
        ignoreErrors: true
      });

      if (fs.existsSync(archivoTemp)) {
        const stats = fs.statSync(archivoTemp);
        if (stats.size > 200 * 1024) { // Mayor a 200 KB
          console.log(`[Éxito SoundCloud]: Archivo obtenido (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          exito = true;
        } else {
          console.warn(`[SoundCloud]: Archivo descargado menor a 200 KB (${stats.size} bytes).`);
          eliminarArchivoTemporal();
        }
      }
    } catch (errSc) {
      console.warn(`[SoundCloud no disponible]: ${errSc.message || errSc}. Pasando a YouTube...`);
      eliminarArchivoTemporal();
    }

    // -------------------------------------------------------------
    // PASO 2: FALLBACK YOUTUBE (Clientes móviles ios/android sin login)
    // -------------------------------------------------------------
    if (!exito) {
      try {
        console.log(`[Paso 2/2 - Fallback]: Buscando en YouTube con clientes móviles (ios,android)...`);
        await ytdlp(`ytsearch1:${busqueda}`, {
          format: 'ba/bestaudio/best',
          extractAudio: true,
          audioFormat: 'mp3',
          ffmpegLocation: ffmpeg.path,
          output: archivoTemp,
          noPlaylist: true,
          noWarnings: true,
          noCheckCertificates: true,
          extractorArgs: 'youtube:player_client=ios,android'
        });

        if (fs.existsSync(archivoTemp)) {
          const stats = fs.statSync(archivoTemp);
          if (stats.size > 200 * 1024) { // Mayor a 200 KB
            console.log(`[Éxito YouTube]: Archivo obtenido (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            exito = true;
          } else {
            console.warn(`[YouTube]: Archivo descargado menor a 200 KB (${stats.size} bytes).`);
            eliminarArchivoTemporal();
          }
        }
      } catch (errYt) {
        console.error(`[YouTube falló]: ${errYt.message || errYt}`);
        eliminarArchivoTemporal();
      }
    }

    // -------------------------------------------------------------
    // PASO 3: ENVÍO DEL ARCHIVO Y LIMPIEZA
    // -------------------------------------------------------------
    if (exito && fs.existsSync(archivoTemp)) {
      const stats = fs.statSync(archivoTemp);
      console.log('[DESCARGA EXITOSA]: Enviando archivo al cliente');

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(busqueda)}.mp3"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');

      // Al completar el envío de la respuesta, eliminar el archivo temporal
      res.on('finish', () => {
        eliminarArchivoTemporal();
      });

      return res.sendFile(archivoTemp, (errEnvio) => {
        if (errEnvio) {
          console.error('[Error enviando archivo]:', errEnvio.message || errEnvio);
          eliminarArchivoTemporal();
        }
      });
    }

    // Si ninguna fuente obtuvo la pista
    eliminarArchivoTemporal();
    if (!res.headersSent) {
      console.error(`[Fallo Definitivo]: No se pudo descargar la pista para "${busqueda}".`);
      return res.status(500).json({
        error: 'No se pudo descargar la pista completa de audio. Intenta con otro término de búsqueda.'
      });
    }
  } catch (errorGeneral) {
    eliminarArchivoTemporal();
    console.error('[Error General]:', errorGeneral);
    if (!res.headersSent) {
      return res.status(500).json({
        error: errorGeneral.message || 'Error interno del servidor al procesar el audio'
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

app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(` Servidor Express Activo en Puerto ${PUERTO}`);
  console.log(` Aplicación web y API: http://localhost:${PUERTO}`);
  console.log(` Servidor estático: ${RUTA_DIST}`);
  console.log(` Motor: SoundCloud Primario + YouTube Clientes Móviles`);
  console.log(`=======================================================`);
});