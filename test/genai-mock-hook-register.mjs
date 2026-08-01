// Registers the loader hook that swaps @google/genai for the local test stub.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./genai-mock-hook.mjs', pathToFileURL('./test/'));
