const express = require('express');
const cors = require('cors');
const ytdlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

// Middleware básico y CORS limpio para cualquier cliente web
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

// Función compartida para búsqueda, stream y descarga de audio
function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`[${new Date().toLocaleTimeString()}] Buscando y transmitiendo: "${busqueda}"...`);

  let headersSent = false;
  let proceso;

  try {
    proceso = ytdlp.exec(`ytsearch1:${busqueda}`, {
      format: '140/bestaudio[ext=m4a]/bestaudio',
      output: '-'
    }, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Si el cliente cancela la petición prematuramente
    req.on('close', () => {
      if (proceso && proceso.kill) {
        try { proceso.kill(); } catch (_) {}
      }
    });

    proceso.on('error', (err) => {
      console.error('Error al iniciar proceso yt-dlp:', err);
      if (!res.headersSent && !headersSent) {
        headersSent = true;
        return res.status(500).json({ error: 'Error al iniciar el proceso de descarga de audio.' });
      }
    });

    let primerChunk = true;

    proceso.stdout.on('data', (chunk) => {
      if (primerChunk) {
        primerChunk = false;
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(busqueda)}.mp3"`,
          'Cache-Control': 'no-cache'
        });
      }
      res.write(chunk);
    });

    proceso.stdout.on('end', () => {
      if (!headersSent) {
        headersSent = true;
        return res.status(500).json({ error: 'No se recibieron datos de audio del proveedor de contenido.' });
      }
      res.end();
    });

    if (proceso.stderr) {
      proceso.stderr.on('data', (data) => {
        const mensaje = data.toString();
        if (mensaje.toLowerCase().includes('error')) {
          console.error(`[yt-dlp error]: ${mensaje.trim()}`);
        }
      });
    }

    proceso.on('close', (code) => {
      if (code !== 0 && !headersSent) {
        headersSent = true;
        return res.status(500).json({ error: `El extractor de audio finalizó con código de error ${code}.` });
      }
    });

  } catch (error) {
    console.error('Excepción al procesar audio:', error);
    if (!res.headersSent && !headersSent) {
      return res.status(500).json({ error: 'Error interno del servidor al procesar la canción.' });
    }
  }
}

// 2. Rutas coincidentes del backend para streaming y descarga
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
  console.log(`=======================================================`);
});