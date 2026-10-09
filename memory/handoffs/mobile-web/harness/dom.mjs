import { chromium } from '/home/claude/dsul/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.mjs';
import { serve } from './serve.mjs';
const { server, origin } = await serve('cur');
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
for (const lay of ['list','schedule','buckets']) {
await p.goto(`${origin}/?shell=phone&layout=${lay}`); await p.waitForTimeout(800);
const r = await p.evaluate(() => {
  const t = [...document.querySelectorAll('*')].find(e => e.childElementCount===0 && e.textContent.trim()==='Groceries');
  let e=t, out=[]; for (let i=0;i<9&&e;i++){ out.push(e.tagName+' '+(e.getAttribute('data-testid')||'')+' | '+(e.className?.baseVal??e.className)+' h='+Math.round(e.getBoundingClientRect().height)); e=e.parentElement }
  return out.join('\n');
});
console.log('==',lay,'\n'+r);
}
const hr = await p.evaluate(()=>{const e=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='Standup'); let x=e,o=[];for(let i=0;i<8&&x;i++){o.push(x.tagName+' '+(x.getAttribute('data-testid')||'')+' | '+(x.className?.baseVal??x.className)+' h='+Math.round(x.getBoundingClientRect().height));x=x.parentElement}return o.join('\n')});
console.log('== standup\n'+hr);
await b.close(); server.close();
