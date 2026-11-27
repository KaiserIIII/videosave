import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(),'videosave-policy-'));
process.env.MEDIA_TOOLKIT_SETTINGS = path.join(directory,'settings.sqlite');
after(() => rm(directory,{recursive:true,force:true}));

test('maximum mode shares a bounded observation budget between stages', async () => {
  const { maximumProbePlan } = await import('../tools/compatibility-policy.mjs');
  const stages = maximumProbePlan(30_000);
  assert.deepEqual(stages,[{waitMs:6000,deep:false},{waitMs:24000,deep:true}]);
  assert.deepEqual(maximumProbePlan(10_000,'deep'),[{waitMs:10_000,deep:true}]);
});

test('site rules export bounded observations and reject sensitive imports', async () => {
  const { compatibilityRules, recordCompatibility } = await import('../tools/compatibility-policy.mjs');
  const origin = 'https://qa.example';
  recordCompatibility(new URL(origin + '/media?token=sensitive'),{stage:'deep',success:true,elapsedMs:1200,kind:'m3u8'});
  recordCompatibility(new URL(origin + '/other'),{stage:'deep',success:true,elapsedMs:1000,kind:'m3u8'});
  const [rule] = compatibilityRules().items;
  assert.equal(rule.origin,origin);
  assert.equal(rule.preferred,'deep');
  assert.equal(rule.averageMs,1100);
  assert.ok(!JSON.stringify(rule).includes('sensitive'));
  assert.throws(() => compatibilityRules({action:'import',items:[{origin:origin + '/private',preferred:'deep'}]}),
    {code:'INVALID_COMPATIBILITY_RULE'});
  assert.throws(() => compatibilityRules({action:'import',items:[{origin,preferred:'deep',token:'sensitive'}]}),
    {code:'INVALID_COMPATIBILITY_RULE'});
  compatibilityRules({action:'import',items:[{origin,preferred:'standard'}]});
  assert.equal(compatibilityRules().items[0].preferred,'standard');
  compatibilityRules({action:'reset'});
  assert.deepEqual(compatibilityRules().items,[]);
});
