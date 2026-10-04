// OpenCode loads only this default export; keep helpers in src/.
import { createServer } from './src/reqall-plugin.js';

export default {
  id: 'reqall',
  server: createServer(),
};
