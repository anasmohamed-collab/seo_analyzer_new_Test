import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Docker production runtime', () => {
  it('includes the shared modules imported by the Express server', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/^COPY --from=builder \/app\/shared \.\/shared$/m);
  });
});
