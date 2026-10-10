const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

// Middleware y CORS limpio
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges']
}));

app.use(express.json());

// 1. Endpoint de chequeo de salud / actividad (Requerido para Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'servidor-musica', port: PUERTO });
});

/**
 * Descarga y extrae audio completo en disco temporal en formato MP3 (320kbps/alta fidelidad)
 * eliminando problemas de cortes a los 9 segundos y fallos de streaming.
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  const idTemp = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const archivoTemp = path.join(os.tmpdir(), `${idTemp}.mp3`);

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Nueva descarga completa: "${busqueda}"`);
  console.log(`[Archivo Temporal]: ${archivoTemp}`);

  const limpiarArchivo = () => {
    try {
      if (fs.existsSync(archivoTemp)) {
        fs.unlinkSync(archivoTemp);
        console.log(`[Limpieza]: Archivo temporal ${archivoTemp} eliminado.`);
      }
    } catch (_) {}
  };

  res.on('finish', limpiarArchivo);
  res.on('close', limpiarArchivo);

  let exito = false;

  // 1. Intento principal: YouTube con extracción nativa a MP3 alta fidelidad
  try {
    console.log(`[Paso 1/2]: Descargando pista completa desde YouTube...`);
    await ytdlp(`ytsearch1:${busqueda}`, {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      ffmpegLocation: ffmpegPath,
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
        console.log(`[Éxito YouTube]: Descargado ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        exito = true;
      } else {
        console.warn(`[Aviso YouTube]: El archivo descargado es menor a 1 MB (${stats.size} bytes). Probando fallback.`);
        limpiarArchivo();
      }
    }
  } catch (errYt) {
    console.warn(`[YouTube Falló]: ${errYt.message || errYt}. Pasando a fallback...`);
    limpiarArchivo();
  }

  // 2. Fallback automático: SoundCloud con extracción completa a MP3
  if (!exito) {
    try {
      console.log(`[Paso 2/2 - Fallback]: Descargando pista completa desde SoundCloud (scsearch1)...`);
      await ytdlp(`scsearch1:${busqueda}`, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0,
        ffmpegLocation: ffmpegPath,
        output: archivoTemp,
        noPlaylist: true,
        matchFilter: 'duration > 60',
        noCheckCertificates: true,
        preferFreeFormats: true,
        noWarnings: true
      });

      if (fs.existsSync(archivoTemp)) {
        const stats = fs.statSync(archivoTemp);
        if (stats.size >= 1024 * 1024) {
          console.log(`[Éxito SoundCloud]: Descargado ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          exito = true;
        } else {
          console.warn(`[Aviso SoundCloud]: El archivo descargado es menor a 1 MB (${stats.size} bytes).`);
          limpiarArchivo();
        }
      }
    } catch (errSc) {
      console.error(`[SoundCloud Falló]: ${errSc.message || errSc}`);
      limpiarArchivo();
    }
  }

  // Si se obtuvo el archivo MP3 completo (> 1 MB)
  if (exito && fs.existsSync(archivoTemp)) {
    const stats = fs.statSync(archivoTemp);
    console.log(`[Enviando MP3]: Transmitiendo archivo completo al cliente (${stats.size} bytes)...`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(busqueda)}.mp3"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    return res.sendFile(archivoTemp, (errEnvio) => {
      if (errEnvio) {
        console.error('[Error al enviar archivo]:', errEnvio);
      }
      limpiarArchivo();
    });
  }

  // Si ninguna fuente logró descargar el archivo completo
  limpiarArchivo();
  if (!res.headersSent) {
    console.error(`[Error Final]: No se pudo descargar la pista completa para "${busqueda}".`);
    return res.status(500).json({
      error: 'No se pudo descargar la pista completa en alta fidelidad. Intenta con otro término de búsqueda.'
    });
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
  console.log(` Motor: Descarga Completa a Disco + Conversión MP3 con ffmpeg`);
  console.log(`=======================================================`);
});