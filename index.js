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

/**
 * Intenta ejecutar yt-dlp con una consulta y opciones específicas.
 * Retorna true si logró transmitir audio al cliente, o false si la fuente falló.
 */
function intentarStreamYtDlp(query, opciones, req, res) {
  return new Promise((resolve) => {
    let proceso;
    let recibioDatos = false;
    let timerTimeout;

    try {
      console.log(`[Motor Audio]: Lanzando extractor para "${query}"...`);
      proceso = ytdlp.exec(query, opciones, { stdio: ['ignore', 'pipe', 'pipe'] });

      const limpiar = () => {
        if (timerTimeout) clearTimeout(timerTimeout);
        if (proceso && proceso.kill) {
          try { proceso.kill(); } catch (_) {}
        }
      };

      req.on('close', limpiar);

      // Si en 14 segundos no hay datos de esta fuente, liberar e intentar siguiente
      timerTimeout = setTimeout(() => {
        if (!recibioDatos) {
          console.warn(`[Timeout]: No hubo chunks de audio en 14s para "${query}".`);
          limpiar();
          resolve(false);
        }
      }, 14000);

      proceso.stdout.on('data', (chunk) => {
        if (!recibioDatos) {
          recibioDatos = true;
          if (timerTimeout) clearTimeout(timerTimeout);
          console.log(`[Streaming OK]: ¡Transmitiendo audio exitosamente desde "${query}"!`);

          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(query)}.mp3"`,
            'Cache-Control': 'no-cache'
          });
        }
        res.write(chunk);
      });

      proceso.stdout.on('end', () => {
        if (timerTimeout) clearTimeout(timerTimeout);
        if (recibioDatos) {
          res.end();
          resolve(true);
        } else {
          resolve(false);
        }
      });

      if (proceso.stderr) {
        proceso.stderr.on('data', (data) => {
          const mensaje = data.toString().trim();
          if (mensaje) {
            console.error(`[yt-dlp stderr (${query})]: ${mensaje}`);
          }
        });
      }

      proceso.on('error', (err) => {
        console.error(`[Error de proceso (${query})]:`, err);
        limpiar();
        if (!recibioDatos) resolve(false);
      });

      proceso.on('close', (code) => {
        if (timerTimeout) clearTimeout(timerTimeout);
        if (!recibioDatos) {
          console.warn(`[Cierre (${query})]: Salió con código ${code} sin datos de audio.`);
          resolve(false);
        }
      });

    } catch (err) {
      console.error(`[Excepción al iniciar extractor (${query})]:`, err);
      resolve(false);
    }
  });
}

/**
 * Manejador unificado con sistema multifuente antibloqueo para IPs de Render
 */
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Nueva petición de descarga: "${busqueda}"`);

  // FUENTE 1: YouTube con flags estándar antibloqueo
  console.log(`[Paso 1/3]: Intentando YouTube estándar...`);
  const ytExito = await intentarStreamYtDlp(
    `ytsearch1:${busqueda}`,
    {
      format: '140/bestaudio[ext=m4a]/bestaudio',
      output: '-',
      noCheckCertificates: true,
      preferFreeFormats: true,
      noWarnings: true
    },
    req,
    res
  );

  if (ytExito) {
    console.log(`[Resultado]: Descarga completada vía YouTube.`);
    return;
  }

  if (res.writableEnded || res.headersSent) return;

  // FUENTE 2: Fallback automático a SoundCloud (Sin bloqueos de Datacenter en Render)
  console.log(`[Paso 2/3 - Fallback]: YouTube no entregó stream. Intentando SoundCloud (scsearch1)...`);
  const scExito = await intentarStreamYtDlp(
    `scsearch1:${busqueda}`,
    {
      format: 'bestaudio',
      output: '-',
      noCheckCertificates: true,
      preferFreeFormats: true,
      noWarnings: true
    },
    req,
    res
  );

  if (scExito) {
    console.log(`[Resultado]: Descarga completada vía SoundCloud.`);
    return;
  }

  if (res.writableEnded || res.headersSent) return;

  // FUENTE 3: Fallback a YouTube con emulación de cliente Android
  console.log(`[Paso 3/3 - Fallback]: Intentando YouTube con emulación de cliente Android...`);
  const ytAndroidExito = await intentarStreamYtDlp(
    `ytsearch1:${busqueda}`,
    {
      format: 'bestaudio',
      output: '-',
      extractorArgs: 'youtube:player_client=android',
      noCheckCertificates: true,
      preferFreeFormats: true,
      noWarnings: true
    },
    req,
    res
  );

  if (ytAndroidExito) {
    console.log(`[Resultado]: Descarga completada vía YouTube Android Client.`);
    return;
  }

  // Si ninguna de las 3 fuentes entregó audio
  if (!res.headersSent && !res.writableEnded) {
    console.error(`[Error Crítico]: Ningún proveedor (YouTube, SoundCloud, Android) entregó audio para "${busqueda}".`);
    return res.status(500).json({
      error: 'No se recibieron datos de audio del proveedor de contenido. Revisa los registros de Render.'
    });
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
  console.log(` Motor de Audio Multifuente: YouTube + SoundCloud Fallback`);
  console.log(`=======================================================`);
});