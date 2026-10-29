import { access, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineApplication, defineTool } from 'runply';
import { fakeModel, modelResponse, toolResponse } from 'runply/testing';

if (process.env.PROBE_MARKER) await writeFile(process.env.PROBE_MARKER, 'trusted module was imported');
if (process.env.FAIL_IMPORT === 'yes') throw new Error('intentional preflight failure');
if (process.env.MUTATE_RELEASE === 'yes') await writeFile('assets/version.txt', 'unexpected probe write');

async function gate(path, signal) {
  await new Promise((accept, reject) => {
    const watcher = watch(dirname(path), check);
    const cancel = () => { watcher.close(); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    async function check() {
      try { await access(path); watcher.close(); signal.removeEventListener('abort', cancel); accept(); }
      catch (error) { if (error.code !== 'ENOENT') { watcher.close(); signal.removeEventListener('abort', cancel); reject(error); } }
    }
    if (signal.aborted) cancel(); else void check();
  });
}

const inputSchema = z.object({ gate: z.string().optional(), started: z.string().optional() });
const resultSchema = z.object({ version: z.string(), binding: z.string(), model: z.string(), secretPresent: z.boolean() });
const application = defineApplication({
  name: 'release-fixture', inputSchema, outputSchema: resultSchema,
  tools: {
    readVersion: defineTool({
      description: 'Read the version from this release after a test-owned gate.', inputSchema: z.object({}), outputSchema: z.object({ version: z.string() }), sideEffect: 'none', idempotent: true,
      async execute(_value, context) {
        const input = inputSchema.parse(context.input);
        if (input.started) await writeFile(input.started, context.runId);
        if (input.gate) await gate(input.gate, context.signal);
        return { version: (await readFile('assets/version.txt', 'utf8')).trim() };
      },
    }),
  },
  messages: () => [{ role: 'user', content: 'Read version and return JSON.' }],
  finalize: value => [{ name: 'result.json', mediaType: 'application/json', content: JSON.stringify(value) }],
});
function scripted(id) {
  const model = fakeModel(({ prompt }) => {
    const outputs = prompt.flatMap(message => message.role === 'tool' ? message.content : []);
    const result = outputs.find(part => part.type === 'tool-result' && part.toolName === 'readVersion');
    if (!result) return toolResponse('readVersion', {}, 'read-version');
    return modelResponse(JSON.stringify({ version: result.output.value.version, binding: process.env.BIND_LABEL ?? 'unset', model: id, secretPresent: Boolean(process.env.BOUND_TEST_SECRET) }));
  });
  return { ...model, id };
}
const first = scripted('fixture:first');
export default { application, model: first, models: { first, second: scripted('fixture:second') }, input: {} };