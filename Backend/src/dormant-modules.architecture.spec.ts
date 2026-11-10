// INFO-1 and INFO-7: code that is kept but deliberately NOT served. Mounting it
// would expose routes nobody reviewed for today's threat model (legacy
// email/password and social sign-in; seller phone and location with no limit
// cap in src/products). These guards fail the build if either is wired in by
// accident; doing it on purpose means changing this test, in review.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const importers = (pattern: RegExp, except: (file: string) => boolean) =>
  sourceFiles(SRC)
    .filter((f) => !except(relative(SRC, f)))
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f));

describe('dormant code stays unmounted', () => {
  it('AuthModule serves the phone-OTP AuthController only', () => {
    // Read from source: importing the module would load provider SDKs.
    const auth = readFileSync(join(SRC, 'auth/auth.module.ts'), 'utf8');
    expect(auth).toMatch(/controllers:\s*\[\s*AuthController\s*\]/);
    expect(auth).not.toMatch(/LegacyAuthController/);
  });

  it('nothing outside its own file imports LegacyAuthController', () => {
    expect(
      importers(
        /from\s+['"][^'"]*legacy-auth\.controller['"]/,
        (f) => f === 'auth/legacy-auth.controller.ts',
      ),
    ).toEqual([]);
  });

  it('nothing outside src/products imports the dormant ProductsModule or its controller', () => {
    expect(
      importers(
        /from\s+['"][^'"]*(?<!admin\/)products\/products\.(module|controller|service)['"]/,
        (f) => f.startsWith('products/'),
      ),
    ).toEqual([]);
  });

  it('AppModule does not import ProductsModule', () => {
    const app = readFileSync(join(SRC, 'app.module.ts'), 'utf8');
    expect(app).not.toMatch(/ProductsModule/);
    expect(app).not.toMatch(/LegacyAuth/);
  });
});
