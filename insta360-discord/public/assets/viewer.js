// Visor web: la dirección es /v/<token>; la señal cuelga de /m/<token>/.

import { mountStage } from './stage.js';

const token = window.location.pathname.split('/').filter(Boolean).pop();
mountStage({
  root: document.getElementById('stage'),
  base: `../m/${encodeURIComponent(token)}/`,
});
