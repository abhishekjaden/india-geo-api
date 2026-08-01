// Loader hook: redirect @google/genai to the local test stub.
// Used only by the security test script, so production code is untouched.
import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const STUB = pathToFileURL(pathResolve(process.cwd(), 'test/stubs/@google/genai/index.js')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@google/genai') {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
