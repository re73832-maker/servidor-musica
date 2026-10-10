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

// Middleware y CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges']
}));

app.use(express.json());

// 1. Endpoint de chequeo de salud / actividad (Requerido para Render)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    port: PUERTO,
    ffmpeg: ffmpeg.path ? 'disponible' : 'no encontrado'
  });
});

/**
 * Descarga y extrae audio completo en disco temporal en formato MP3 (alta fidelidad)
 * utilizando el binario estático de FFmpeg (@ffmpeg-installer/ffmpeg).
 * Si YouTube bloquea la petición por ser IP de datacenter (ej. Render), recurre automáticamente a SoundCloud.
 * El archivo temporal se transmite con res.sendFile() y se elimina con fs.unlink.
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  const idTemp = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const archivoTemp = path.join(os.tmpdir(), `${idTemp}.mp3`);

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Nueva descarga solicitada: "${busqueda}"`);
  console.log(`[Archivo Temporal]: ${archivoTemp}`);
  console.log(`[FFmpeg Path]: ${ffmpeg.path}`);

  const borrarArchivo = () => {
    try {
      fs.unlink(archivoTemp, () => {});
    } catch (_) {}
  };

  // Limpieza de seguridad si el cliente aborta la conexión
  res.on('close', () => {
    if (!res.writableEnded) {
      borrarArchivo();
    }
  });

  try {
    let exito = false;

    // 1. Intento principal: YouTube
    try {
      console.log(`[Paso 1/2]: Intentando descarga completa desde YouTube...`);
      await ytdlp(`ytsearch1:${busqueda}`, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        ffmpegLocation: ffmpeg.path,
        output: archivoTemp,
        noPlaylist: true,
        matchFilter: 'duration > 60',
        noCheckCertificates: true,
        preferFreeFormats: true,
        noWarnings: true
      });

      if (fs.existsSync(archivoTemp)) {
        const stats = fs.statSync(archivoTemp);
        if (stats.size >= 1024 * 1024) { // Más de 1 MB
          console.log(`[Éxito YouTube]: Archivo generado correctamente (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          exito = true;
        } else {
          console.warn(`[Aviso YouTube]: Archivo incompleto o inferior a 1 MB (${stats.size} bytes). Intentando SoundCloud...`);
          borrarArchivo();
        }
      }
    } catch (errYt) {
      console.warn(`[YouTube bloqueado o falló]: ${errYt.message || errYt}. Activando fallback a SoundCloud...`);
      borrarArchivo();
    }

    // 2. Fallback automático: SoundCloud (Pistas completas sin preview para Datacenters)
    if (!exito) {
      try {
        console.log(`[Paso 2/2 - Fallback]: Intentando descarga completa desde SoundCloud (scsearch1)...`);
        await ytdlp(`scsearch1:${busqueda}`, {
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: 0,
          ffmpegLocation: ffmpeg.path,
          output: archivoTemp,
          noPlaylist: true,
          matchFilter: 'duration > 60',
          noCheckCertificates: true,
          preferFreeFormats: true,
          noWarnings: true
        });

        if (fs.existsSync(archivoTemp)) {
          const stats = fs.statSync(archivoTemp);
          if (stats.size >= 1024 * 1024) { // Más de 1 MB
            console.log(`[Éxito SoundCloud]: Archivo generado correctamente (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            exito = true;
          } else {
            console.warn(`[Aviso SoundCloud]: Archivo inferior a 1 MB (${stats.size} bytes).`);
            borrarArchivo();
          }
        }
      } catch (errSc) {
        console.error(`[SoundCloud falló]: ${errSc.message || errSc}`);
        borrarArchivo();
      }
    }

    // 3. Envío del archivo completo al cliente y posterior borrado
    if (exito && fs.existsSync(archivoTemp)) {
      const stats = fs.statSync(archivoTemp);
      console.log(`[Enviando MP3]: Transmitiendo archivo completo al cliente (${stats.size} bytes)...`);

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(busqueda)}.mp3"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');

      return res.sendFile(archivoTemp, (errEnvio) => {
        // Borrar el archivo temporal con fs.unlink una vez enviado
        borrarArchivo();
        if (errEnvio) {
          console.error('[Error durante el envío de sendFile]:', errEnvio.message || errEnvio);
        } else {
          console.log(`[Envío Exitoso]: Canción "${busqueda}" transmitida y archivo temporal eliminado.`);
        }
      });
    }

    // Si ninguna fuente logró descargar el audio
    borrarArchivo();
    if (!res.headersSent) {
      console.error(`[Error Final]: No se pudo descargar audio completo para "${busqueda}".`);
      return res.status(500).json({
        error: 'No se pudo descargar la pista completa de audio. Intenta con otro término de búsqueda.'
      });
    }
  } catch (errorGeneral) {
    borrarArchivo();
    console.error('[Error no controlado en descarga]:', errorGeneral);
    if (!res.headersSent) {
      return res.status(500).json({
        error: errorGeneral.message || 'Error interno del servidor al procesar la descarga de audio.'
      });
    }
  }
}

// 2. Rutas del backend
app.get('/descargar', manejarDescargaAudio);
app.get('/buscar', manejarDescargaAudio);
app.get('/stream', manejarDescargaAudio);

// 3. Servir archivos estáticos del frontend compilado desde ./dist local
app.use(express.static(RUTA_DIST));

// 4. Fallback para SPA y PWA: cualquier ruta GET no API devuelve ./dist/index.html
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
  console.log(` Servidor Express Unificado Activo en Puerto ${PUERTO}`);
  console.log(` Aplicación web y API: http://localhost:${PUERTO}`);
  console.log(` Sirviendo frontend desde carpeta local: ${RUTA_DIST}`);
  console.log(` Chequeo de actividad: http://localhost:${PUERTO}/health`);
  console.log(` Motor: FFmpeg (@ffmpeg-installer/ffmpeg) + yt-dlp + Fallback SoundCloud`);
  console.log(`=======================================================`);
});