const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PUERTO = 4000;

app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('¡El motor de descargas de música está funcionando!');
});

// NUEVA RUTA: El motor que descarga la música
app.get('/descargar', (req, res) => {
  const busqueda = req.query.q;

  if (!busqueda) {
    return res.status(400).send('Debes enviar el nombre de una canción.');
  }

  console.log(`Buscando y preparando audio de: ${busqueda}...`);

  res.header('Content-Type', 'audio/mp4');
  res.header('Content-Disposition', `attachment; filename="cancion.mp4"`);

  // Quitamos el jsEngine que causó el error y dejamos solo el disfraz de Android
  const proceso = ytDlp.exec(`ytsearch1:${busqueda}`, {
    format: 'bestaudio', 
    extractorArgs: 'youtube:player_client=android', 
    output: '-' 
  }, { stdio: ['ignore', 'pipe', 'inherit'] });

  proceso.stdout.pipe(res);
});

// Iniciar el servidor
app.listen(PUERTO, () => {
  console.log(`Servidor activo y escuchando en http://localhost:${PUERTO}`);
});