const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

// Middleware básico y CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'ngrok-skip-browser-warning',
    'Bypass-Tunnel-Reminder'
  ],
  exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

app.use(express.json());

// 1. Endpoint de chequeo de salud / actividad (Requerido para Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'servidor-musica', port: PUERTO });
});

// 2. Endpoint principal de descarga y streaming de audio
app.get('/descargar', (req, res) => {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).send('Debes enviar el nombre de una canción en el parámetro ?q=');
  }

  console.log(`[${new Date().toLocaleTimeString()}] Buscando y transmitiendo: "${busqueda}"...`);

  // Cabeceras de streaming
  res.header('Content-Type', 'audio/mp4');
  res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(busqueda)}.m4a"`);
  res.header('Cache-Control', 'no-cache');

  try {
    const proceso = ytdlp.exec(`ytsearch1:${busqueda}`, {
      format: '140/bestaudio[ext=m4a]/bestaudio',
      output: '-'
    }, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (proceso.stdout) {
      proceso.stdout.pipe(res);
    }

    if (proceso.stderr) {
      proceso.stderr.on('data', (data) => {
        const mensaje = data.toString();
        if (mensaje.toLowerCase().includes('error')) {
          console.error(`[yt-dlp error]: ${mensaje}`);
        }
      });
    }

    // Manejar aborto de la conexión por parte del cliente
    req.on('close', () => {
      if (proceso && proceso.kill) {
        try {
          proceso.kill();
        } catch (_) {}
      }
    });

    proceso.on('error', (err) => {
      console.error('Error al ejecutar yt-dlp:', err);
      if (!res.headersSent) {
        res.status(500).send('Error al procesar la descarga de audio.');
      }
    });
  } catch (error) {
    console.error('Excepción en /descargar:', error);
    if (!res.headersSent) {
      res.status(500).send('Error interno del servidor.');
    }
  }
});

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
  console.log(`=======================================================`);
});