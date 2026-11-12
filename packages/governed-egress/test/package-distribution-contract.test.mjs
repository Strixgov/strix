import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));

// Distribution contract, revised 2026-11-11. #2893 (owner direction to sell
// the product) made the package publishable; the earlier internal-only
// contract (#2832) asserted private:true and is superseded. Publishable is not
// published: npm state is measured by lint-distribution-truth and recorded in
// platform-maturity-register.json, never asserted here.
test('governed-egress is a publishable npm package under its exact identity',()=>{
  assert.equal(pkg.name,'@strixgov/governed-egress');
  assert.equal(pkg.version,'0.1.0');
  assert.notEqual(pkg.private,true);
  assert.equal(pkg.repository?.url,'https://github.com/Strixgov/strix');
  assert.equal(pkg.repository?.directory,'packages/governed-egress');
});
test('publishable distribution keeps the Elastic-2.0 source license',()=>{
  assert.equal(pkg.license,'Elastic-2.0');
  assert.equal(existsSync(join(root,'LICENSE')),true);
  assert.match(readFileSync(join(root,'LICENSE'),'utf8'),/^Elastic License 2\.0/m);
  assert.ok(pkg.files.includes('LICENSE')&&pkg.files.includes('COMMERCIAL.md'),'LICENSE and COMMERCIAL.md ship in the tarball');
});
test('the published file set excludes tests, fixtures and demos',()=>{
  for (const f of pkg.files) assert.doesNotMatch(f,/^(test|fixtures|demo|accuracy)\b/,`${f} must not ship`);
});
