// Empaqueta el SDK oficial de Discord para Actividades en un único fichero que
// el navegador puede cargar sin paso de compilación. El resultado
// (public/vendor/discord-sdk.js) se guarda en el repositorio; vuelve a ejecutar
// `npm run build:sdk` solo si actualizas @discord/embedded-app-sdk.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules/@discord/embedded-app-sdk/package.json'), 'utf8'),
);

await build({
  stdin: {
    contents: "import { DiscordSDK } from '@discord/embedded-app-sdk';\nglobalThis.DiscordSDK = DiscordSDK;\n",
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2019',
  legalComments: 'none',
  banner: {
    js: `/*! @discord/embedded-app-sdk v${pkg.version} — licencia MIT — https://github.com/discord/embedded-app-sdk */`,
  },
  outfile: path.join(root, 'public/vendor/discord-sdk.js'),
});

const size = fs.statSync(path.join(root, 'public/vendor/discord-sdk.js')).size;
console.log(`public/vendor/discord-sdk.js generado (${Math.round(size / 1024)} kB, SDK v${pkg.version})`);
