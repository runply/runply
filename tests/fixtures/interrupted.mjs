import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { runApplication, defineApplication, defineTool, SQLiteRunStore, LocalWorkspace } from '../../dist/index.js';
import { fakeModel, toolResponse } from '../../dist/testing/index.js';

const [database, artifacts, marker] = process.argv.slice(2);
// A pending Promise alone does not keep Node alive; retain the parent IPC channel.
process.on('message', () => {});
const store = new SQLiteRunStore(database);
const workspace = new LocalWorkspace(artifacts);
const app = defineApplication({
  name: 'interruption-fixture', inputSchema: z.object({}), outputSchema: z.object({}),
  tools: {
    externalWrite: defineTool({
      description: 'Test-owned file write followed by a deliberate wait.', inputSchema: z.object({}), outputSchema: z.object({}),
      sideEffect: 'external', idempotent: false,
      async execute(_input, context) {
        await writeFile(marker, 'one execution\n', { flag: 'a' });
        process.send({ runId: context.runId });
        return new Promise(() => {});
      },
    }),
  },
  messages: () => [{ role: 'user', content: 'Run the test-owned tool.' }], finalize: () => [],
});
await runApplication(app, {}, { model: fakeModel(() => toolResponse('externalWrite', {}, 'external')), store, workspace });