const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PUERTO = 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('¡El motor de descargas de música está funcionando!');
});

app.get('/descargar', (req, res) => {
  const busqueda = req.query.q;

  if (!busqueda) {
    return res.status(400).send('Debes enviar el nombre de una canción.');
  }

  console.log(`Buscando y preparando audio de: ${busqueda}...`);

  res.header('Content-Type', 'audio/mp4');
  res.header('Content-Disposition', `attachment; filename="cancion.mp4"`);

  // SOLUCIÓN DEFINITIVA: Buscar en SoundCloud (scsearch1:) para saltar el bloqueo de IP de YouTube
  const proceso = ytDlp.exec(`scsearch1:${busqueda}`, {
    format: 'bestaudio', 
    output: '-' 
  }, { stdio: ['ignore', 'pipe', 'inherit'] });

  proceso.stdout.pipe(res);
});

app.listen(PUERTO, () => {
  console.log(`Servidor activo y escuchando en http://localhost:${PUERTO}`);
});