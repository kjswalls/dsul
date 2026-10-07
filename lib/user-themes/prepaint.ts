import { PREPAINT_TABLE } from '@/lib/mods/theme-grammar';
import { USER_THEME_CACHE_KEY, USER_THEME_SELECTORS } from './css';

/**
 * The third pre-paint script in app/layout.tsx, after the one that stamps
 * data-look-light / data-look-dark (memory/plans/mods.md, "Injection").
 *
 * For each stamped pick shaped like a user theme's slug it finds that theme in
 * the localStorage cache, checks every declaration against PREPAINT_TABLE (a
 * known name, a value of the printed shape) and writes the live rules into
 * `<style id="dsul-user-themes-boot">` with textContent, the same text
 * composeUserThemeCss writes with `preview: false`. A missing entry, any
 * failing declaration, or `?safe-mode` removes the attribute instead, so the
 * default theme paints cleanly and the saved pick is untouched.
 *
 * ES5 and self-contained: it runs before React, in every browser the app
 * supports. The table and the selectors arrive as JSON from the same modules
 * the app uses, and tests/unit/user-theme-prepaint.test.ts runs it.
 */

const TABLE = Object.fromEntries(Object.entries(PREPAINT_TABLE).map(([name, t]) => [name, [t.scope, t.re]]));

export const USER_THEME_PREPAINT =
  '(function(){try{' +
  `var T=${JSON.stringify(TABLE)},S=${JSON.stringify(USER_THEME_SELECTORS)},K=${JSON.stringify(USER_THEME_CACHE_KEY)};` +
  "var r=document.documentElement,U=/^u-[0-9a-f]{8}$/,H=/^#[0-9a-f]{6}$/,A=[['data-look-light','light'],['data-look-dark','dark']],safe=false,c=null,css='',i,j;" +
  "try{safe=new URLSearchParams(location.search).has('safe-mode')}catch(e){}" +
  'if(!safe){try{c=JSON.parse(localStorage.getItem(K)||"null")}catch(e){c=null}}' +
  'function own(o,k){return Object.prototype.hasOwnProperty.call(o,k)}' +
  "function rule(sel,slug,d){if(!d.length)return'';return sel.split('%s').join(slug)+'{'+d.join(';')+'}\\n'}" +
  'function build(e,slug,m){' +
  "if(!e||typeof e!=='object'||e.s!==slug||e.m!==m||typeof e.c!=='string'||!H.test(e.c)||!e.d||typeof e.d.length!=='number')return null;" +
  'var g={root:[],body:[],ask:[]},k,d,t;' +
  "for(k=0;k<e.d.length;k++){d=e.d[k];if(!d||d.length!==2||typeof d[0]!=='string'||typeof d[1]!=='string'||!own(T,d[0]))return null;" +
  't=T[d[0]];if(!new RegExp(t[1]).test(d[1]))return null;g[t[0]].push(d[0]+\':\'+d[1])}' +
  'var s=S[m];return rule(s.root,slug,g.root)+rule(s.body,slug,g.body)+rule(s.ask,slug,g.ask)}' +
  'for(i=0;i<A.length;i++){var a=A[i][0],m=A[i][1],v=r.getAttribute(a),e=null,out=null;' +
  'if(!v||!U.test(v))continue;' +
  'if(!safe&&c&&c.v===1&&c.t&&typeof c.t.length==="number"){for(j=0;j<c.t.length;j++){if(c.t[j]&&c.t[j].s===v&&c.t[j].m===m){e=c.t[j];break}}}' +
  'out=e?build(e,v,m):null;' +
  'if(out===null){r.removeAttribute(a)}else{css+=out}}' +
  "if(css){var st=document.createElement('style');st.id='dsul-user-themes-boot';st.textContent=css;document.head.appendChild(st)}" +
  '}catch(x){}})()';
