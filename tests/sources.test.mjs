import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {waitAllSourcesReady} from '../lib/notebooklm.mjs';
const urls=['https://www.youtube.com/watch?v=abcdefghijk'];
async function fixture(html,run){
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 try{const page=await browser.newPage();await page.setContent(html);await run(page);}finally{await browser.close();}
}
test('ready row requires exact source identity',async()=>{
 await fixture('<div class="single-source-container"><a href="'+urls[0]+'">Source</a></div>',page=>waitAllSourcesReady(page,urls,{timeout:100,poll:5}));
});
test('unrelated identity never reports success',async()=>{
 await fixture('<div class="single-source-container"><a href="https://www.youtube.com/watch?v=wrong">Source</a></div>',page=>assert.rejects(waitAllSourcesReady(page,urls,{timeout:100,poll:5}),/could not be verified/));
});
test('failed source and spinner never report success',async()=>{
 for(const html of ['<div class="single-source-container">Processing failed</div>','<div class="single-source-container"><span role="progressbar"></span></div>'])
  await fixture(html,page=>assert.rejects(waitAllSourcesReady(page,urls,{timeout:100,poll:5})));
});
