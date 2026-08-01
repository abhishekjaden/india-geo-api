// Local test stub. Returns whatever globalThis.__NEXT_INTENT__ holds.
class GoogleGenAI {
  constructor() {
    this.models = {
      generateContent: async () => {
        const v = globalThis.__NEXT_INTENT__;
        if (globalThis.__THROW_ERR__) { const e = new Error('upstream'); e.status = globalThis.__THROW_ERR__; globalThis.__THROW_ERR__ = null; throw e; }
        return { text: typeof v === 'string' ? v : JSON.stringify(v) };
      },
    };
  }
}
module.exports = { GoogleGenAI };
